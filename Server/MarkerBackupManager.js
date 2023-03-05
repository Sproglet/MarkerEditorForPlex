// External dependencies
import { existsSync, mkdirSync } from 'fs';
import { join as joinPath } from 'path';

// Client/Server shared dependencies
import { EpisodeData, MarkerData, MarkerEnum, MarkerType, MovieData } from '../Shared/PlexTypes.js';
import { Log } from '../Shared/ConsoleLog.js';

// Server dependencies/typedefs
import { ExtraData, MetadataType, PlexQueries } from './PlexQueryManager.js';
import DatabaseWrapper from './DatabaseWrapper.js';
import { MarkerCache } from './MarkerCacheManager.js';
import ServerError from './ServerError.js';
import TransactionBuilder from './TransactionBuilder.js';

/** @typedef {!import('../Shared/PlexTypes').MarkerAction} MarkerAction */
/** @typedef {!import('../Shared/PlexTypes').PurgeSection} PurgeSection */
/** @typedef {!import('../Shared/PlexTypes').PurgeShow} PurgeShow */
/** @typedef {!import('./PlexQueryManager').MultipleMarkerQuery} MultipleMarkerQuery */
/** @typedef {!import('./PlexQueryManager').RawMarkerData} RawMarkerData */


/*
Backup table V1:

| COLUMN       | TYPE         | DESCRIPTION                                                                       |
+--------------+--------------+-----------------------------------------------------------------------------------+
| id           | INT NOT NULL | Autoincrement primary key                                                         |
+ -------------|--------------+-----------------------------------------------------------------------------------+
| op           | INT NOT NULL | The operation type, see MarkerOp above.                                           |
+--------------|--------------+-----------------------------------------------------------------------------------+
| marker_id    | INT NOT NULL | The id of the modified marker.                                                    |
+--------------|--------------+-----------------------------------------------------------------------------------+
| episode_id   | INT NOT NULL | The metadata id of the episode the marker is attached to                          |
+--------------|--------------+-----------------------------------------------------------------------------------+
| season_id    | INT NOT NULL | The metadata id of the season the marker is attached to                           |
+--------------|--------------+-----------------------------------------------------------------------------------+
| show_id      | INT NOT NULL | The metadata id of the show the marker is attached to                             |
+--------------|--------------+-----------------------------------------------------------------------------------+
| start        | INT NOT NULL | The start time of the marker                                                      |
+--------------|--------------+-----------------------------------------------------------------------------------+
| end          | INT NOT NULL | The end time of the marker                                                        |
+--------------|--------------+-----------------------------------------------------------------------------------+
| old_start    | INT          | MarkerOp.Edit only - the previous start time of the marker                        |
+--------------|--------------+-----------------------------------------------------------------------------------+
| old_end      | INT          | MarkerOp.Edit only - the previous end time of the marker                          |
+--------------|--------------+-----------------------------------------------------------------------------------+
| modified_at  | VARCHAR(255) | The date the marker was last edited, if any.                                      |
+--------------|--------------+-----------------------------------------------------------------------------------+
| created_at   | DATETIME     | The date the marker was added to the Plex database. Also follows the thumb_url    |
|              |              | schema of appending a '*' if the marker was not created by Plex.                  |
+--------------|--------------+-----------------------------------------------------------------------------------+
| recorded_at  | DATETIME     | The date the marker was added to this backup table.                               |
+--------------|--------------+-----------------------------------------------------------------------------------+
| extra_data   | VARCHAR(255) | The extra data field from the Plex database (see ExtraData)                       |
+--------------|--------------+-----------------------------------------------------------------------------------+
| section_uuid | VARCHAR(255) | The unique identifier for the library section this marker belongs to, aiming to   |
|              |              | avoid confusion if the same backup database is used for multiple Plex databases.  |
+--------------|--------------+-----------------------------------------------------------------------------------+
| restores_id  | INT          | MarkerOp.Restore only - the marker_id that this marker restored                   |
+--------------|--------------+-----------------------------------------------------------------------------------+
| restored_id  | INT          | If this marker was deleted by Plex and restored by the user, this is the marker   |
|              |              | id of the new marker created to replace this one.                                 |
+--------------|--------------+-----------------------------------------------------------------------------------+

Indexes:
* episode_id, season_id, show_id, section_uuid -> grouping options that may be common (find lost markers
  at the episode/season/show/section level).
* restored_id, marker_id -> potentially useful if we're making a bunch of chained calls to find a trail of deletes/restores.
*/

/*
Backup table V2 additions:

| COLUMN     | TYPE | DESCRIPTION                                       |
+------------+------+---------------------------------------------------+
| section_id | INT  | The library section id this marker is attached to |
+------------+------+---------------------------------------------------+

Indexes:
* section_id

While the section id isn't a wholly unique identifier if multiple servers are using the
same database, it's still convenient to have in the context of a single server's actions.
*/

/*
Backup table V3 additions:

| COLUMN       | TYPE         | DESCRIPTION                                       |
+--------------+--------------+---------------------------------------------------+
| episode_guid | VARCHAR(255) | The library section id this marker is attached to |
+--------------+--------------+---------------------------------------------------+

In the following scenario, we can lose track of marker adds/edits:
  1. An episode is added.
  2. A marker for the episode is added/edited.
  3. The episode is deleted.
  4. The episode is added again.

In this case, the metadata id is not enough.
*/

/*
Backup table V4 additions:

| COLUMN       | TYPE         | DESCRIPTION                                                                     |
+--------------+--------------+---------------------------------------------------------------------------------+
| modified_at  | INTEGER      | Was DATETIME, but Plex this to an epoch time in late 2022, so mirror that       |
+--------------+--------------+---------------------------------------------------------------------------------+
| created_at   | INTEGER      | Was DATETIME, but Plex this to an epoch time in late 2022, so mirror that       |
+--------------+--------------+---------------------------------------------------------------------------------+
| recorded_at  | INTEGER      | Was DATETIME, but Plex this to an epoch time in late 2022, so mirror that       |
+--------------|--------------|---------------------------------------------------------------------------------+
| marker_type  | VARCHAR(255) | The type of marker (e.g. 'intro' or 'credits')                                  |
+--------------+--------------+---------------------------------------------------------------------------------+
| final        | INTEGER      | 1/0. Whether this is the final marker. Only applicable if marker_type='credits' |
+--------------+--------------+---------------------------------------------------------------------------------+
| user_created | INTEGER      | 1/0. Whether this marker was created by the user.                               |
+--------------+--------------+---------------------------------------------------------------------------------+

Indexes:
* marker_type

PMS 1.31.0.6654 introduced credits detection, and along with it a new marker type,
'credits'. Add the two fields above to capture this new information.
*/

/*
Backup table V5 modifications:

| OLD COLUMN   | NEW COLUMN  | DESCRIPTION                                              |
+--------------+-------------+----------------------------------------------------------+
| episode_id   | parent_id   | Rename the column to be more agnostic for movie markers. |
+--------------+-------------+----------------------------------------------------------+
| episode_guid | parent_guid | See above.                                               |
+--------------+-------------+----------------------------------------------------------+

With the introduction of credit markers, there's a more compelling reason to allow movies
to also be marked. The schema itself is still okay, but rename some columns so episodes
aren't explicitly referenced.
*/


/**
 * The accepted operation types
 * @enum */
const MarkerOp = {
    /** The user added a marker. */
    Add : 1,
    /** The user edited a marker. */
    Edit : 2,
    /** The user deleted a marker. */
    Delete : 3,
    /** Restoring a previous marker that exists in the table. */
    Restore : 4
};

/* eslint-disable indent */
/** The main table. See above for details. */
const ActionsTable = `
CREATE TABLE IF NOT EXISTS actions (
    id           INTEGER      PRIMARY KEY AUTOINCREMENT,
    op           INTEGER      NOT NULL,
    marker_id    INTEGER      NOT NULL,
    parent_id    INTEGER      NOT NULL,` /* V5: episode_id -> parent_id */ + `
    season_id    INTEGER      NOT NULL,` /* V5: -1 indicates a movie marker */ + `
    show_id      INTEGER      NOT NULL,` /* V5: -1 indicates a movie marker */ + `
    start        INTEGER      NOT NULL,
    end          INTEGER      NOT NULL,
    old_start    INTEGER,
    old_end      INTEGER,
    modified_at  INTEGER      DEFAULT NULL,` /* V4 -> VARCHAR to INTEGER */ + `
    created_at   INTEGER      NOT NULL,` /* V4 -> DATETIME to INTEGER */+ `
    recorded_at  INTEGER      DEFAULT (strftime('%s','now')),` /* V4 -> DATETIME to INTEGER */ + `
    extra_data   VARCHAR(255) NOT NULL,
    section_uuid VARCHAR(255) NOT NULL,
    restores_id  INTEGER,
    restored_id  INTEGER,` +
    /* V2 */`
    section_id   INTEGER      NOT NULL DEFAULT -1,` +
    /* V3 */`
    parent_guid  VARCHAR(255) DEFAULT NULL,` /* V5: episode_guid -> parent_guid */ +
    /* V4 */`
    marker_type  VARCHAR(255) DEFAULT 'intro',
    final        INTEGER      DEFAULT 0,
    user_created INTEGER      DEFAULT 0
);
`;
/* eslint-enable*/

/**
 * A map of purged markers
 * @typedef {{ [sectionId: number] : PurgeSection }} PurgeMap
 */

/** The current table schema version. */
const CurrentSchemaVersion = 5;

/** Single-row table that indicates the current version of the actions table. */
const CheckVersionTable = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER
);
INSERT INTO schema_version (version) SELECT ${CurrentSchemaVersion} WHERE NOT EXISTS (SELECT * FROM schema_version);
`;


/** "Create index if not exists"
 * @type {(indexName: string, columnName: string) => string} */
const ciine = (indexName, columnName) => `CREATE INDEX IF NOT EXISTS idx_actions_${indexName} ON actions(${columnName})`;

/** The list of CREATE INDEX statements to execute after creating the Actions table. */
const CreateIndexes = `
${ciine('uuid', 'section_uuid')};
${ciine('eid', 'parent_id')};
${ciine('seasonid', 'season_id')};
${ciine('showid', 'show_id')};
${ciine('mid', 'marker_id')};
${ciine('resid', 'restored_id')};
${ciine('sectionid', 'section_id')};
${ciine('markertype', 'marker_type')};
`;

/* eslint-disable indent */
// Queries to execute when upgrading from SchemaUpgrades[version] to SchemaUpgrades[version + 1]
const SchemaUpgrades = [
    // New database. Create the full table and its indexes. (and drop the existing actions table as a precaution)
    // Set version to current version, as a new database starts with the latest schema version.
    `DROP TABLE IF EXISTS actions;
    ${ActionsTable} ${CheckVersionTable} ${CreateIndexes}
    UPDATE schema_version SET version=${CurrentSchemaVersion};`,

    // 1 -> 2: Add the section_id column and create an index for it
    // We don't want it to be null, but don't know the right value right now, so default to -1,
    // which will indicate it needs an upgrade.
    `ALTER TABLE actions ADD COLUMN section_id INTEGER NOT NULL DEFAULT -1;
    ${ciine('sectionid', 'section_id')};
    UPDATE schema_version SET version=2;`,

    // 2 -> 3: Add episode_guid column
    `ALTER TABLE actions ADD COLUMN episode_guid VARCHAR(255) DEFAULT NULL;
    UPDATE schema_version SET version=3;`,

    // 3 -> 4:
    // * Add marker_type, final for Credits support
    // * Add user_created to avoid timestamp hacks (and properly transfer status)
    // * Move to epoch timestamps.
    /* eslint-disable max-len */
    `ALTER TABLE actions ADD COLUMN marker_type  VARCHAR(255) DEFAULT 'intro';
    ALTER TABLE actions ADD COLUMN final        INTEGER      DEFAULT 0;
    ALTER TABLE actions ADD COLUMN user_created INTEGER      DEFAULT 0;
	UPDATE actions SET user_created=1 WHERE substr(modified_at, length(modified_at))='*';
    ${ciine('markertype', 'marker_type')};
    PRAGMA writable_schema = TRUE;
    UPDATE sqlite_schema SET sql = replace(replace(replace(sql, 'modified_at  VARCHAR(255)', 'modified_at  INTEGER'), 'DATETIME', 'INTEGER'), 'CURRENT_TIMESTAMP', "(strftime('%s', 'now'))") WHERE name='actions' AND type='table';
    PRAGMA writable_schema = RESET;
    UPDATE actions SET modified_at = iif(typeof(modified_at) in ('datetime', 'text'), CAST(strftime('%s', modified_at) as INTEGER), modified_at);
    UPDATE actions SET created_at  = iif(typeof(created_at)  in ('datetime', 'text'), CAST(strftime('%s', created_at)  as INTEGER), created_at );
    UPDATE actions SET recorded_at = iif(typeof(recorded_at) in ('datetime', 'text'), CAST(strftime('%s', recorded_at) as INTEGER), recorded_at);
    UPDATE schema_version SET version=4;`,
    /* eslint-enable */

    // 4 -> 5:
    // Movie support. No major changes, but rename episode_id/guid to parent_id/guid so it more generically
    // refers to the marker's owner (either an episode or a movie)
    `ALTER TABLE actions RENAME COLUMN episode_id TO parent_id;
     ALTER TABLE actions RENAME COLUMN episode_guid TO parent_guid;
     UPDATE schema_version SET version=5;`,
];
/* eslint-enable */

/**
 * Singleton backup manager instance
 * @type {MarkerBackupManager}
 * @readonly */ // Externally readonly
let Instance;

/**
 * The MarkerRecorder class handles interactions with a database that keeps track of all the user's marker actions.
 *
 * The main motivation behind this class is Plex's behavior of wiping out markers on analysis (even its own previous
 * markers, which it restores as new markers). This database of recorded actions can be used to help determine what
 * user-modified markers no longer exist, and restore them in the Plex database.
 *
 * [Maybe] TODO: Add a different view to the main page that shows recently added episodes, and allow drilling down
 * into its season to detect whether any markers were lost, and give the user the option to recover them.
 */
class MarkerBackupManager {
    /** @type {DatabaseWrapper} */
    #actions;

    /** Unique identifiers for the library sections of the existing database.
     * Used to properly map a marker action to the right library, regardless of the underlying database used.
     * @type {{[sectionId: number]: string}} */
    #uuids = {};

    /** @type {PurgeMap} */
    #purgeCache = null;
    /** @type {{[sectionId: number]: number}} */
    #sectionTypes = {};

    /** @type {(async (callback: Function) => void)[]} */
    #schemaUpgradeCallbacks = [
        async () => { },
        this.#updateSectionIdAfterUpgrade.bind(this),
        async () => { }, // addEpisodeGuidAfterUpgrade, but we do it outside the main update process
        // New columns have default values that are guaranteed to be correct,
        // but we need to update our hacked thumb_urls in the main database.
        this.#checkBadThumbUrls.bind(this),
        async () => { }, // 4 -> 5. Just renaming columns, nothing else to do.
    ];

    /**
     * Create a new MarkerBackupManager instance. This should always be used
     * opposed to creating a new MarkerBackupManager directly.
     * @param {string} dataRoot The root of this project, to determine where the backup database is. */
    static async CreateInstance(dataRoot) {
        if (Instance) {
            Log.warn(`Backup manager already initialized, we shouldn't be trying to do this again!`);
            MarkerBackupManager.Close();
        }

        Log.info('MarkerBackupManager: Initializing marker backup database...');
        /** @type {{id: number, uuid: string, section_type: number}[]} */
        let sections;
        try {
            sections = await PlexQueries.sectionUuids();
        } catch (err) {
            Log.error(`MarkerBackupManager: Unable to get existing library sections. Can't properly backup marker actions`);
            throw err;
        }

        const sectionTypes = {};
        const uuids = {};
        for (const section of sections) {
            uuids[section.id] = section.uuid;
            sectionTypes[section.id] = section.section_type;
        }

        const dbPath = joinPath(dataRoot, 'Backup');
        if (!existsSync(dbPath)) {
            Log.verbose('MarkerBackupManager: Backup path does not exist, creating it.');
            mkdirSync(dbPath);
        }

        const fullPath = joinPath(dbPath, 'markerActions.db');
        const dbExists = existsSync(fullPath);
        if (!dbExists) {
            Log.info(`MarkerBackupManager: No backup marker database found, creating it (${fullPath}).`);
        } else {
            Log.tmi(`MarkerBackupManager: Backup database found, attempting to open...`);
        }

        try {
            const db = await DatabaseWrapper.CreateDatabase(fullPath, true /*allowCreate*/);
            Log.tmi('MarkerBackupManager: Opened database, checking schema');
            await db.exec(CheckVersionTable);
            if (!dbExists) {
                await db.exec(SchemaUpgrades[0]);
            }

            const row = await db.get('SELECT version FROM schema_version;');
            const version = row ? row.version : 0;
            const manager = new MarkerBackupManager(uuids, sectionTypes, db);
            if (version != CurrentSchemaVersion) {
                if (version != 0) {
                    // Only log if this isn't a new database, i.e. version isn't 0.
                    Log.info(`MarkerBackupManager: Old database schema detected (${version}), attempting to upgrade.`);
                }

                await manager.upgradeSchema(version);
            }

            // 2 -> 3 Add guids if necessary
            // TODO: Do something similar for 1 -> 2?
            await manager.postUpgrade();

            Log.info(fullPath, 'MarkerBackupManager: Initialized backup database');
            Instance = manager;
            return manager;
        } catch (err) {
            Log.error('MarkerBackupManager: Unable to create/open backup database, exiting...');
            throw err;
        }
    }

    /** Clear out the singleton backup manager instance. */
    static Close() { Instance?.close(); Instance = null; }

    /**
     * @param {{[sectionId: number]: string}} uuids A map of section ids to UUIDs to uniquely identify a section across severs.
     * @param {{[sectionId: number]: number}} sectionTypes A map of section ids to the type of library it is.
     *                                                     Used to differentiate hierarchies in the purge map.
     * @param {DatabaseWrapper} actionsDatabase The connection to the backup database. */
    constructor(uuids, sectionTypes, actionsDatabase) {
        this.#uuids = uuids;
        this.#sectionTypes = sectionTypes;
        this.#actions = actionsDatabase;
    }

    /** Closes the database connection. */
    async close() {
        Log.verbose('MarkerBackupManager: Shutting down backup database connection...');
        try {
            await this.#actions?.close();
            Log.verbose('MarkerBackupManager: Shut down backup database connection.');
        } catch (err) {
            Log.error('MarkerBackupManager: Backup marker database close failed', err.message);
        }
    }

    /**
     * Attempts to update the database to match the current schema.
     * @param {number} oldVersion The current schema version of the backup database. */
    async upgradeSchema(oldVersion) {
        const nextVersion = oldVersion + 1;
        Log.info(`MarkerBackupManager: Upgrading from schema version ${oldVersion} to ${nextVersion}...`);
        await this.#actions.exec(SchemaUpgrades[oldVersion]);
        await this.#schemaUpgradeCallbacks[oldVersion]();
        if (nextVersion != CurrentSchemaVersion) {
            await this.upgradeSchema(nextVersion);
        } else {
            Log.info('MarkerBackupManager: Successfully upgraded database schema.');
            Log.info('MarkerBackupManager: Initialized backup database');
        }
    }

    /**
     * Updates the backup database to set the correct section_id, which will be -1 if
     * the user performed any actions with the V1 database schema.
     * This should be a one-time operation (per server associated with this application). */
    async #updateSectionIdAfterUpgrade() {
        Log.verbose('MarkerBackupManager: Setting section_id after upgrading schema.');

        const transaction = new TransactionBuilder(this.#actions);
        for (const [section, uuid] of Object.entries(this.#uuids)) {
            transaction.addStatement('UPDATE actions SET section_id=? WHERE section_uuid=?;', [section, uuid]);
        }

        await transaction.exec();
    }

    /**
     * V4 schema upgrade callback, updating our hacked thumb_url entries in the Plex database
     * to be epoch timestamps like everything else, also preserving the 'userCreated' flag. */
    async #checkBadThumbUrls() {
        // The Plex DB manager shouldn't have to know about this, so interact
        // directly with the underlying database.
        const db = PlexQueries.database();

        // First, note which markers are user-created, as we need to switch from the '*' postfix to the negative number notation
        const modifiedMarkersQuery =
            `SELECT id, thumb_url FROM taggings WHERE length(thumb_url) > 0 AND tag_id=${PlexQueries.markerTagId()};`;
        const modifiedMarkers = await db.all(modifiedMarkersQuery);
        const txn = new TransactionBuilder(db);
        for (const marker of modifiedMarkers) {
            const userCreated = marker.thumb_url.endsWith('*');
            const dateParam = userCreated ? marker.thumb_url.substring(0, marker.thumb_url.length - 1) : marker.thumb_url;
            let date = (new Date(dateParam).getTime() / 1000) * (userCreated ? -1 : 1);
            if (isNaN(date)) {
                // Did another instance already switch to epoch?
                const asEpoch = Math.abs(marker.thumb_url);
                if (isNaN(asEpoch)) {
                    // Bad data, reset to blank
                    date = '';
                } else {
                    const year = new Date(asEpoch * 1000).getFullYear();
                    if (year > 1990 && year < Date.now()) {
                        date = marker.thumb_url;
                    } else {
                        date = '';
                    }
                }
            }

            txn.addStatement(`UPDATE taggings SET thumb_url=? WHERE id=?`, [date, marker.id]);
        }

        await txn.exec();
    }

    /**
     * Checks whether the given actions need to be updated to have the correct section id
     * @param {MarkerAction[]} actions The actions to inspect
     * @param {() => void} callback Callback to invoke after updating section ids, if necessary
     * @returns Whether section ids need to be updated */
    async #verifySectionIds(actions) {
        if (actions.length <= 0 || actions[0].section_id != -1) {
            return false;
        }

        // Remnants of schema 1 => 2 transition. The initial transition should have
        // properly updated the section_id for the current server, but this is possible
        // if the user has multiple servers that are using the same backup database.
        await this.#updateSectionIdAfterUpgrade();
        return true;
    }

    /**
     * Check for one-time actions required after a schema upgrade.
     * Since the backup database supports multiple servers, we may need to run updates
     * outside of the immediate schema upgrade. */
    async postUpgrade() {
        await this.#addParentGuidAfterUpgrade();
    }

    /**
     * Check for relevant marker actions that don't have an episode guid set.
     * If relevant actions are found that we can't find a guid for, that means the episode is deleted
     * and can no longer be restored, so will be marked as ignored in the database. */
    async #addParentGuidAfterUpgrade() {
        const allActionsQuery = this.#allActionsQuery(true);
        /** @type {MarkerAction[]} */
        const allActions = await this.#actions.all(allActionsQuery.query, allActionsQuery.parameters);
        if (!allActions || allActions.length == 0) {
            Log.verbose('MarkerBackupManager: No active actions missing episode guid.');
            return;
        }

        /** @type {{ [sectionId: number]: MarkerAction[] }} */
        const bySection = {};
        for (const action of allActions) {
            (bySection[action.section_id] ??= []).push(action);
        }

        Log.info('MarkerBackupManager: Found marker actions without an episode guid. Attempting to match them now.');
        const transaction = new TransactionBuilder(this.#actions);
        for (const [sectionId, actions] of Object.entries(bySection)) {
            const items = await PlexQueries.baseGuidsForSection(sectionId);
            for (const action of actions) {
                const guid = items[action.parent_id];
                if (!guid) {
                    Log.warn(`MarkerBackupManager: Unable to find matching guid for metadata item ${action.parent_id}, ` +
                        `marking it as ignored as it cannot be restored.`);
                    transaction.addStatement(
                        'UPDATE actions SET restored_id=-1 WHERE marker_id=? AND section_uuid=?',
                        [action.marker_id, this.#uuids[sectionId]]);
                    continue;
                }

                const parameters = [guid, action.marker_id, action.marker_id, this.#uuids[sectionId]];
                transaction.addStatement(
                    'UPDATE actions SET parent_guid=? WHERE (marker_id=? OR restored_id=?) AND section_uuid=?',
                    parameters);
            }
        }

        Log.info(`MarkerBackupManager: Running ${transaction.statementCount()} queries to update guids.`);
        await transaction.exec();
    }

    /**
     * Core method that inserts a record into the backup database.
     * @param {TransactionBuilder} transaction
     * @param {number} markerOp
     * @param {MarkerData} marker
     * @param {{start: number, end: number}?} oldTimings
     * @param {number?} restoresId */
    #recordOp(transaction, markerOp, marker, oldTimings=null, restoresId=null) {
        const query = `INSERT INTO actions (
op, marker_id, parent_id, season_id, show_id, section_id, start, end, old_start, old_end, modified_at, created_at,
extra_data, section_uuid, restores_id, parent_guid, marker_type, final, user_created) VALUES (
$op, $id, $pid, $seasonId, $showId, $sectionId, $start, $end, $oldStart, $oldEnd, $modifiedAt, $createdAt,
$extraData, $sectionUUID, $restoresId, $parentGuid, $markerType, $final, $userCreated);`;

        let modifiedAt;
        let createdAt;
        const asRaw = new Set();
        oldTimings = oldTimings || { start : null, end : null };
        const nowTime = `(strftime('%s', 'now'))`;
        switch (markerOp) {
            case MarkerOp.Add:
                modifiedAt = nowTime;
                createdAt = nowTime;
                asRaw.add('$modifiedAt');
                asRaw.add('$createdAt');
                break;
            case MarkerOp.Edit:
            case MarkerOp.Delete:
                modifiedAt = nowTime;
                createdAt = marker.createDate;
                asRaw.add('$modifiedAt');
                break;
            case MarkerOp.Restore:
                modifiedAt = marker.modifiedDate;
                createdAt = marker.createDate;
                break;
            default:
                throw new ServerError(`Unknown marker backup operation (${markerOp}), cannot back up action.`, 500);
        }

        const parameters = {
            $op : markerOp,
            $id : marker.id,
            $pid : marker.parentId,
            $seasonId : marker.seasonId,
            $showId : marker.showId,
            $sectionId : marker.sectionId,
            $start : marker.start,
            $end : marker.end,
            $oldStart : oldTimings.start,
            $oldEnd : oldTimings.end,
            $modifiedAt : modifiedAt,
            $createdAt : createdAt,
            $extraData : ExtraData.get(marker.markerType, marker.isFinal),
            $sectionUUID : this.#uuids[marker.sectionId],
            $restoresId : restoresId,
            $parentGuid : marker.parentGuid,
            $markerType : marker.markerType,
            $final : marker.isFinal,
            $userCreated : marker.createdByUser,
            _asRaw : asRaw,
        };

        transaction.addStatement(query, parameters);
    }

    /**
     * Records a marker that was added to the Plex database.
     * @param {MarkerData[]} markers */
    async recordAdds(markers) {
        const transaction = new TransactionBuilder(this.#actions);
        for (const marker of markers) {
            if (!(marker.sectionId in this.#uuids)) {
                Log.error(marker.sectionId, 'MarkerBackupManager: Unable to record added marker - unexpected section id');
                return;
            }

            this.#recordOp(transaction, MarkerOp.Add, marker);
        }

        if (transaction.empty()) {
            return;
        }

        try {
            await transaction.exec();
            Log.verbose(`MarkerBackupManager: ${transaction.statementCount()} marker add(s) added to backup.`);
        } catch (err) {
            Log.error(err.message, 'MarkerBackupManager: Unable to record added marker');
        }
    }

    /**
     * Records a marker that was edited in the Plex database.
     * @param {MarkerData[]} markers
     * @param {{[markerId: number]: {start : number, end : number}}} oldMarkerTimings */
    async recordEdits(markers, oldMarkerTimings) {
        const transaction = new TransactionBuilder(this.#actions);
        for (const marker of markers) {
            if (!(marker.sectionId in this.#uuids)) {
                Log.error(marker.sectionId, 'MarkerBackupManager: Unable to record edited marker - unexpected section id');
                continue;
            }

            const oldTimings = oldMarkerTimings[marker.id];
            if (!oldTimings) {
                Log.error(marker.id, 'MarkerBackupManager: Unable to record edited marker - marker id not in old timings map');
                continue;
            }

            this.#recordOp(transaction, MarkerOp.Edit, marker, oldTimings);
        }

        if (transaction.empty()) {
            return;
        }

        try {
            await transaction.exec();
            Log.verbose(`MarkerBackupManager: Backed up ${transaction.statementCount()} marker edit(s).`);
        } catch (err) {
            Log.error(err.message, 'MarkerBackupManager: Unable to record edited marker');
        }
    }

    /**
     * Records a marker that was deleted from the Plex database.
     * @param {MarkerData[]} markers */
    async recordDeletes(markers) {
        const transaction = new TransactionBuilder(this.#actions);
        for (const marker of markers) {
            if (!(marker.sectionId in this.#uuids)) {
                Log.error(marker.sectionId, 'MarkerBackupManager: Unable to record deleted marker - unexpected section id');
                continue;
            }

            this.#recordOp(transaction, MarkerOp.Delete, marker);
        }

        if (transaction.empty()) {
            return;
        }

        try {
            await transaction.exec();
            Log.verbose(`MarkerBackupManager: ${transaction.statementCount()} marker delete(s) added to backup.`);
        } catch (err) {
            Log.error(err.message, 'MarkerBackupManager: Unable to record deleted markers');
        }
    }

    /**
     * Records a restore operation in the database.
     * @param {{marker : RawMarkerData, oldMarkerId : number}[]} restores The markers to record
     * @param {number} sectionId The id of the section this marker belongs to. */
    async recordRestores(restores, sectionId) {
        const transaction = new TransactionBuilder(this.#actions);

        for (const restore of restores) {
            const marker = new MarkerData(restore.marker);
            this.#recordOp(transaction, MarkerOp.Restore, marker, null /*oldTimings*/, restore.oldMarkerId);

            const updateQuery = 'UPDATE actions SET restored_id=? WHERE marker_id=? AND section_uuid=?;\n';
            const updateParameters = [restore.marker.id, restore.oldMarkerId, this.#uuids[sectionId]];
            transaction.addStatement(updateQuery, updateParameters);
        }

        try {
            await transaction.exec();
        } catch (err) {
            // Swallow the error, though we should probably actually do something about this.
            Log.error(err.message, 'MarkerBackupManager: Unable to record restoration of marker');
        }
    }

    /**
     * Checks for markers that the backup database thinks should exist, but aren't in the Plex database.
     * @param {number} metadataId
     * @returns {Promise<MarkerAction[]>}
     * @throws {ServerError} On failure. */
    async checkForPurges(metadataId) {
        const markerData = await PlexQueries.getMarkersAuto(metadataId);
        const existingMarkers = markerData.markers;
        const typeInfo = markerData.typeInfo;

        const markerMap = {};
        for (const marker of existingMarkers) {
            markerMap[marker.id] = marker;
        }

        const mediaType = this.#columnFromMediaType(typeInfo.metadata_type);
        /** @type {{[parentId: number]: MarkerAction[]}} */
        const baseItemMap = {};
        const actions = await this.#getExpectedMarkers(metadataId, mediaType, typeInfo.section_id);
        for (const action of actions) {
            // Don't add markers that exist in the database, or whose last recorded action was a delete.
            if (!markerMap[action.marker_id] && action.op != MarkerOp.Delete) {
                // Note: while this is "cleaner", it's a bit gross since it doesn't work with
                // primitives, only objects due to reference semantics.
                (baseItemMap[action.parent_id] ??= []).push(action);
            }
        }

        if (typeInfo.metadata_type == MetadataType.Movie) {
            await this.#populateMovieData(baseItemMap);
        } else {
            await this.#populateEpisodeData(baseItemMap);
        }

        /** @type {MarkerAction[]} */
        let pruned = [];
        for (const actions of Object.values(baseItemMap)) {
            pruned = pruned.concat(actions);
        }

        return pruned;
    }

    /**
     * Find and attach episode data for the given episodes.
     * @param {{ [episodeId: number]: [MarkerAction] }} episodeMap  */
    async #populateEpisodeData(episodeMap) {
        if (Object.keys(episodeMap).length == 0) {
            return;
        }

        const episodes = await PlexQueries.getEpisodesFromList(Object.keys(episodeMap));
        for (const episode of episodes) {
            if (!episodeMap[episode.id]) {
                Log.warn(`MarkerBackupManager: Couldn't find episode ${episode.id} in purge list.`);
                continue;
            }

            const episodeData = new EpisodeData(episode);
            for (const markerAction of episodeMap[episode.id]) {
                markerAction.episodeData = episodeData;
            }
        }

        for (const eid of Object.keys(episodeMap)) {
            // This should only happen when the episode doesn't exist anymore.
            // TODO: Use GUID matching in backup db in addition to metadata id.
            // But still scope it to the same library to prevent cross-library contamination.
            if (!episodeMap[eid][0].episodeData) {
                delete episodeMap[eid];
            }
        }
    }

    /**
     * Find and attach movie data for the given movies.
     * _Very_ similar to populateEpisodeData. What can be shared?
     * TODO: can markerAction.episodeData and markerAction.movieData be combined?
     * @param {{[movieId: number]: MarkerAction[] }} movieMap */
    async #populateMovieData(movieMap) {
        if (Object.keys(movieMap).length == 0) {
            return;
        }

        const movies = await PlexQueries.getMoviesFromList(Object.keys(movieMap));
        for (const movie of movies) {
            if (!movieMap[movie.id]) {
                Log.warn(`MarkerBackupManager: Couldn't find movie ${movie.id} in purge list.`);
                continue;
            }

            const movieData = new MovieData(movie);
            for (const markerAction of movieMap[movie.id]) {
                markerAction.movieData = movieData;
            }
        }

        for (const mid of Object.keys(movieMap)) {
            // See eid loop in populateEpisodeData
            if (!movieMap[mid][0].movieData) {
                delete movieMap[mid];
            }
        }
    }

    /**
     * Return a query that will grab the latest action for each marker associated with the current server.
     * @param {boolean} guidCheck `true` if we're checking for episode guids, in which case we don't care about ignored actions. */
    #allActionsQuery(guidCheck=false) {
        let uuidString = '';
        const parameters = [];
        for (const uuid of Object.values(this.#uuids)) {
            parameters.push(uuid);
            uuidString += `section_uuid=? OR `;
        }

        uuidString = uuidString.substring(0, uuidString.length - 4);

        const query = `
SELECT *, MAX(id) FROM actions
WHERE (${uuidString}) AND restored_id IS NULL ${guidCheck ? 'AND parent_guid IS NULL' : ''}
GROUP BY marker_id, section_uuid
ORDER BY id DESC;`;

        return {
            query : query,
            parameters : parameters
        };
    }

    /**
     * Queries the backup database for markers from all sections of the server and checks
     * whether they exist in the Plex database.
     * @returns {Promise<void>} */
    async buildAllPurges() {
        const allActionsQuery = this.#allActionsQuery();

        /** @type {MarkerAction[]} */
        const actions = await this.#actions.all(allActionsQuery.query, allActionsQuery.parameters);

        // If we need to update ids, hold off for now and rerun buildAllPurges once complete (schema 1 to 2).
        if (await this.#verifySectionIds(actions)) {
            return this.buildAllPurges();
        }

        const disconnected = {};
        for (const action of actions) {
            if (action.op == MarkerOp.Delete) {
                continue; // Last action was a user delete, ignore it.
            }

            // TODO: UI similar to bulk add - show what conflicts with existing markers.
            //       Conflict resolution similar to bulk add, with new 'replace' option.
            //       Integrate into bulk action base table for multiselect, etc
            if (!MarkerCache.baseItemExists(action.parent_id)) {
                if (!action.parent_guid) {
                    // Episode doesn't exist and we don't have a guid to associate in the future, mark as ignored
                    Log.warn(`Episode for marker id ${action.id} not found, marking as ignored since it cannot be recovered.`);
                    (disconnected[action.section_id] ??= []).push(action.marker_id);
                    continue;
                }

                const fromGuid = await (action.show_id != -1 ?
                    PlexQueries.getEpisodeFromGuid(action.parent_guid) :
                    PlexQueries.getMovieFromGuid(action.parent_guid));
                if (!fromGuid) {
                    Log.verbose(`No episode found for marker id ${action.id}, ` +
                        `but keeping around in case the episode guid is added in the future.`);
                    continue;
                }

                // Query should guarantee that we only parse a single marker once, so we can call this here
                // without worrying about running this multiple times for the same marker when parsing all actions.
                await this.#updateMarkerMetadataIds(action, fromGuid.id, fromGuid.season_id, fromGuid.show_id);
            }

            if (MarkerCache.baseItemExists(action.parent_id) && !MarkerCache.markerExists(action.marker_id)) {
                this.#addToPurgeMap(action);
            }
        }

        // Ignore disconnected markers all at once
        for (const [sectionId, markerIds] of Object.entries(disconnected)) {
            this.ignorePurgedMarkers(markerIds, sectionId);
        }

        // If no purged markers were found, initialize an empty cache to indicate that.
        this.#purgeCache ??= {};

        const purgeCount = this.purgeCount();
        if (purgeCount > 0) {
            Log.warn(`Found ${purgeCount} purged markers to be addressed.`);
        } else {
            Log.info(`Looked for purged markers and didn't find any`);
        }
    }

    /**
     * Updates the metadata ids associated with a given marker (e.g. after an episode is deleted and re-added).
     * @param {MarkerAction} action
     * @param {number} episodeId
     * @param {number} seasonId
     * @param {number} showId */
    async #updateMarkerMetadataIds(action, episodeId, seasonId, showId) {
        const query = `UPDATE actions SET parent_id=?, season_id=?, show_id=? WHERE marker_id=?`;
        await this.#actions.run(query, [episodeId, seasonId, showId, action.marker_id]);
    }

    /**
     * Add the given marker action to the purge map.
     * @param {MarkerAction} action */
    #addToPurgeMap(action) {
        this.#purgeCache ??= {};

        // Each instance of this application is tied to a single server's database,
        // so it's okay to use the section_id instead of the globally unique section_uuid.
        const section = this.#purgeCache[action.section_id] ??= {};
        if (this.#sectionTypes[action.section_id] == MetadataType.Movie) {
            (section[action.parent_id] ??= {})[action.marker_id] = action;
        } else {
            const show = section[action.show_id] ??= {};
            const season = show[action.season_id] ??= {};
            (season[action.parent_id] ??= {})[action.marker_id] = action;
        }
    }

    /**
     * Remove the given marker action from the purge cache.
     * @param {MarkerAction} action */
    #removeFromPurgeMap(action) {
        /* eslint-disable padding-line-between-statements */
        if (!this.#purgeCache) { return; }
        if (!this.#purgeCache[action.section_id]) { return; }
        const section = this.#purgeCache[action.section_id];
        if (this.#sectionTypes[action.section_id] == MetadataType.Movie) {
            if (!section[action.parent_id]) { return; }
            const movie = section[action.parent_id];
            if (!movie[action.marker_id]) { return; }
            delete movie[action.marker_id];
            if (Object.keys(movie).length == 0) { delete section[action.parent_id]; }
        } else {
            if (!section[action.show_id]) { return; }
            const show = section[action.show_id];
            if (!show[action.season_id]) { return; }
            const season = show[action.season_id];
            if (!season[action.parent_id]) { return; }
            const episode = season[action.parent_id];
            if (!episode[action.marker_id]) { return; }

            if (episode[action.marker_id]) { delete episode[action.marker_id]; }

            if (Object.keys(episode).length == 0) { delete season[action.parent_id]; }
            if (Object.keys(season).length == 0) { delete show[action.season_id]; }
            if (Object.keys(show).length == 0) { delete section[action.show_id]; }
        }

        if (Object.keys(section).length == 0) { delete this.#purgeCache[action.section_id]; }
        /* eslint-enable */
    }

    /** @returns The number of purged markers found for the entire server. */
    purgeCount() {
        if (!this.#purgeCache) {
            return 0; // Didn't initialize main purge cache, return 0
        }

        let count = 0;
        for (const [sectionId, section] of Object.entries(this.#purgeCache)) {
            if (this.#sectionTypes[sectionId] == MetadataType.Movie) {
                // Movies don't have the hierarchy
                for (const movie of Object.values(section)) {
                    count += Object.keys(movie).length;
                }

                continue;
            }

            // Otherwise we have the full show/season/episode/marker hierarchy
            for (const show of Object.values(section)) {
                for (const season of Object.values(show)) {
                    for (const episode of Object.values(season)) {
                        count += Object.keys(episode).length;
                    }
                }
            }
        }

        return count;
    }

    /**
     * Retrieve purged markers for the given library section.
     * @param {number} sectionId The section to parse.
     * @returns {Promise<PurgeSection>} Tree of purged `MarkerAction`s.
     * @throws {ServerError} If the cache is not initialized or the section does not exist. */
    async purgesForSection(sectionId) {
        return this.#purgesForSectionInternal(sectionId, true /*populateData*/);
    }

    /**
     * Retrieve purged markers for the given library section.
     * @param {number} sectionId The section to parse.
     * @param {boolean} populateData Whether to grab movie/episode data for each marker. This will
     *        be false when we're wiping out a section, since we just want the base data to delete. */
    async #purgesForSectionInternal(sectionId, populateData) {
        if (!this.#purgeCache) {
            throw new ServerError('Purge cache not initialized, cannot query for purges.', 500);
        }

        if (!this.#purgeCache[sectionId]) {
            return {};
        }

        if (this.#sectionTypes[sectionId] === MetadataType.Movie) {
            return this.#purgesForMovieSection(sectionId, populateData);
        }

        return this.#purgesForTVSection(sectionId, populateData);
    }

    async #purgesForTVSection(sectionId, populateData) {
        const needsEpisodeData = {};
        for (const show of Object.values(this.#purgeCache[sectionId])) {
            for (const season of Object.values(show)) {
                for (const episode of Object.values(season)) {
                    for (const markerAction of Object.values(episode)) {
                        if (!markerAction.episodeData) {
                            (needsEpisodeData[markerAction.parent_id] ??= []).push(markerAction);
                        }
                    }
                }
            }
        }

        if (populateData) {
            await this.#populateEpisodeData(needsEpisodeData);
        }

        return this.#purgeCache[sectionId];
    }

    /**
     * Retrieve all purged markers associated with the given movie library
     * @param {number} sectionId */
    async #purgesForMovieSection(sectionId, populateData) {
        const needsMovieData = {};
        for (const movie of Object.values(this.#purgeCache[sectionId])) {
            for (const markerAction of Object.values(movie)) {
                if (!markerAction.movieData) {
                    (needsMovieData[markerAction.parent_id] ??= []).push(markerAction);
                }
            }
        }

        if (populateData) {
            await this.#populateMovieData(needsMovieData);
        }

        return this.#purgeCache[sectionId];
    }

    /**
     * @param {number} mediaType The metadata_type from the Plex database.
     * @returns The corresponding string for the media type.
     * @throws {ServerError} if `mediaType` is not an episode, season, or series. */
    #columnFromMediaType(mediaType) {
        switch (mediaType) {
            case MetadataType.Show: return 'show';
            case MetadataType.Season: return 'season';
            case MetadataType.Episode: case MetadataType.Movie: return 'parent';
            default:
                Log.error(`MarkerBackupManager: The caller should have verified a valid value already.`);
                throw new ServerError(`columnFromMediaType: Unexpected media type ${mediaType}`, 400);
        }
    }

    /**
     * Retrieve the list of markers that we expect to exist in the Plex database for a media item.
     * @param {number} metadataId
     * @param {string} mediaType The type metadataId points to (parent, season, or show)
     * @param {number} sectionId
     * @returns {Promise<MarkerAction[]>}*/
    async #getExpectedMarkers(metadataId, mediaType, sectionId) {
        // Get the latest marker action for each marker associated with the given metadataId,
        // ignoring those whose last operation was a delete.
        const query = `
SELECT *, MAX(id) FROM actions
WHERE ${mediaType}_id=? AND section_uuid=? AND restored_id IS NULL
GROUP BY marker_id, ${mediaType}_id, section_uuid
ORDER BY id DESC;`;
        const parameters = [metadataId, this.#uuids[sectionId]];

        /**@type {MarkerAction[]}*/
        const actions = await this.#actions.all(query, parameters);
        if (await this.#verifySectionIds(actions)) {
            return this.#getExpectedMarkers(metadataId, mediaType, sectionId);
        }

        return actions;
    }

    /**
     * Attempts to restore the markers specified by the given ids
     * @param {number[]} oldMarkerIds The ids of the old markers we're trying to restore.
     * @param {number} sectionId The id of the section the old marker belonged to.
     * @param {number} resolveType How to resolve overlapping markers. */
    async restoreMarkers(oldMarkerIds, sectionId, resolveType) {
        if (!(sectionId in this.#uuids)) {
            throw new ServerError(`Unable to restore marker - unexpected section id: ${sectionId}`, 400);
        }

        Log.verbose(`MarkerBackupManager: Attempting to restore ${oldMarkerIds.length} marker(s).`);
        let query = 'SELECT * FROM actions WHERE (';
        const parameters = [];
        for (const oldMarkerId of oldMarkerIds) {
            const markerId = parseInt(oldMarkerId);
            if (isNaN(markerId)) {
                throw new ServerError(`Trying to restore an invalid marker id ${oldMarkerId}`, 400);
            }

            parameters.push(markerId);
            query += `marker_id=? OR `;
        }

        query = query.substring(0, query.length - 4);
        parameters.push(this.#uuids[sectionId]);
        query += `) AND section_uuid=? ORDER BY id DESC;`;

        /** @type {MarkerAction[]} */
        const rows = await this.#actions.all(query, parameters);
        if (rows.length == 0) {
            throw new ServerError(`No markers found with ids ${oldMarkerIds} to restore.`, 400);
        }

        const foundMarkers = {};

        /** @type {{ [parent_id: number] : MarkerAction[] }} */
        const toRestore = {};
        for (const markerAction of rows) {
            if (foundMarkers[markerAction.marker_id]) {
                continue;
            }

            foundMarkers[markerAction.marker_id] = true;
            (toRestore[markerAction.parent_id] ??= []).push(markerAction);
        }

        const markerData = await PlexQueries.bulkRestore(toRestore, this.#sectionTypes[sectionId], resolveType);

        // First thing to log is deletes, as we want order to indicate that they were replaced by subsequent entries.
        const deletedMarkers = markerData.deletedMarkers.map(x => new MarkerData(x));
        if (deletedMarkers.length > 0) {
            await this.recordDeletes(deletedMarkers);
        }

        // Then record edits
        const editedMarkers = [];
        if (markerData.modifiedMarkers.length > 0) {
            const oldTimings = {};
            for (const mod of markerData.modifiedMarkers) {
                const edited = mod.marker;
                const newData = mod.newData;
                oldTimings[edited.id] = { start : edited.start, end : edited.end };
                edited.start = newData.newStart;
                edited.end = newData.newEnd;
                edited.modified_date = newData.newModified;
                edited.marker_type = newData.newType;
                edited.final = newData.newFinal;
                editedMarkers.push(new MarkerData(edited));
            }

            await this.recordEdits(editedMarkers, oldTimings);
        }

        // Then the ones we actually restored.
        const newMarkers = markerData.newMarkers;

        let restoredList = [];

        for (const newMarker of newMarkers) {
            let oldAction = toRestore[newMarker.parent_id].filter(a => a.start == newMarker.start && a.end == newMarker.end);
            if (oldAction.length != 1) {
                Log.warn(`Unable to match new marker against old marker action, some things may be out of sync.`);
                continue;
            }

            oldAction = oldAction[0];
            restoredList.push({ marker : newMarker, oldMarkerId : oldAction.marker_id });

            // We fire and forget the restoration action, so we're really just assuming we did
            // the right thing and preemptively remove it from the purge map.
            this.#removeFromPurgeMap(oldAction);
        }

        await this.recordRestores(restoredList, sectionId);

        // Then "ignored via identical" markers, where we pretend the exiting marker is the one
        // we created to restore the purged one.
        const ignoredMarkers = markerData.identicalMarkers;
        restoredList = [];

        // Essentially the same loop as above, but separate to distinguish between newly added and existing markers
        for (const ignoredMarker of ignoredMarkers) {
            let oldAction = toRestore[ignoredMarker.parent_id].filter(a => a.start == ignoredMarker.start && a.end == ignoredMarker.end);
            if (oldAction.length != 1) {
                Log.warn(`Unable to match identical marker against old marker action, some things may be out of sync.`);
                continue;
            }

            oldAction = oldAction[0];
            Log.tmi(`MarkerBackupManager::restoreMarkers: Identical marker found, setting it as the restored id.`);
            restoredList.push({ marker : ignoredMarker, oldMarkerId : oldAction.marker_id });
            this.#removeFromPurgeMap(oldAction);
        }

        await this.recordRestores(restoredList, sectionId);

        // Finally, ignore anything that we decided to ignore based on the resolution type/overlapping status.
        if (markerData.ignoredActions.length > 0) {
            await this.ignorePurgedMarkers(markerData.ignoredActions.map(a => a.marker_id), sectionId);
        }

        // Return everything that might require a client-side update: restored, deleted existing, and modifiedExisting.
        // TODO: converge to processing either MarkerData or RawMarkerData throughout. E.g. MarkerCache prefers
        //       RawMarkerData, but BackupManager prefers MarkerData, leading to excessive conversions.
        return {
            restoredMarkers : newMarkers,
            deletedMarkers : deletedMarkers,
            modifiedMarkers : editedMarkers,
            ignoredMarkers : ignoredMarkers.length + markerData.ignoredActions.length
        };
    }

    /**
     * Ignores purged markers to exclude them from purge queries.
     * @param {number[]} oldMarkerIds The ids of the old markers we're trying to ignore.
     * @param {number} sectionId The id of the section the old markers belonged to. */
    async ignorePurgedMarkers(oldMarkerIds, sectionId) {
        if (!(sectionId in this.#uuids)) {
            throw new ServerError(`Unable to restore marker - unexpected section id: ${sectionId}`, 400);
        }

        const idSet = {};
        Log.verbose(`MarkerBackupManager: Attempting to ignore ${oldMarkerIds} marker(s).`);

        // Set the restored_id to -1, which will exclude it from the 'look for purged' query,
        // while also letting us know that there isn't a real marker that
        let query = 'UPDATE actions SET restored_id=-1 WHERE (';
        const parameters = [];
        for (const oldMarkerId of oldMarkerIds) {
            const markerId = parseInt(oldMarkerId);
            if (isNaN(markerId)) {
                throw new ServerError(`Trying to restore an invalid marker id ${oldMarkerId}`, 400);
            }

            idSet[oldMarkerId] = true;
            parameters.push(markerId);
            query += `marker_id=? OR `;
        }

        query = query.substring(0, query.length - 4);
        parameters.push(this.#uuids[sectionId]);
        query += ') AND section_uuid=?';
        await this.#actions.run(query, parameters);

        // Inefficient, but I'm lazy
        if (this.#sectionTypes[sectionId] == MetadataType.Movie) {
            for (const movie of Object.values(this.#purgeCache[sectionId])) {
                for (const markerAction of Object.values(movie)) {
                    if (idSet[markerAction.marker_id]) {
                        this.#removeFromPurgeMap(markerAction);
                    }
                }
            }
        } else {
            for (const show of Object.values(this.#purgeCache[sectionId])) {
                for (const season of Object.values(show)) {
                    for (const episode of Object.values(season)) {
                        for (const markerAction of Object.values(episode)) {
                            if (idSet[markerAction.marker_id]) {
                                this.#removeFromPurgeMap(markerAction);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Erases all traces of the given marker type(s) from the backup database. I.e.
     * deletes items in a completely unrecoverable way.
     * @param {number} sectionId
     * @param {number} deleteType */
    async nukeSection(sectionId, deleteType) {
        // Note, the backup database shouldn't have unknown marker types, but still be safe by
        // explicitly only deleting intros and/or credits, not 'commercial' or other unknown types.
        if (!(sectionId in this.#uuids)) {
            throw new ServerError(`Unable to restore marker - unexpected section id: ${sectionId}`, 400);
        }

        const params = [this.#uuids[sectionId]];
        let whereClause = 'WHERE section_uuid=? AND (';
        let addText = '';
        for (const markerType of Object.values(MarkerType)) {
            if (MarkerEnum.typeMatch(markerType, deleteType)) {
                addText += ' OR marker_type=?';
                params.push(markerType);
            }
        }

        whereClause += addText.substring(4) + ')';

        /** @type {number} */
        const deleteCount = (await this.#actions.get(`SELECT COUNT(*) AS count FROM actions ${whereClause};`, params)).count;

        Log.info(`Removing ${deleteCount} entries from the backup database.`);
        await this.#actions.run(`DELETE FROM actions ${whereClause};`, params);

        // Now clear out any purged markers that we just deleted.
        // Inefficient, and copy/paste but I'm lazy
        if (this.#sectionTypes[sectionId] == MetadataType.Movie) {
            for (const movie of Object.values(this.#purgeCache[sectionId])) {
                for (const markerAction of Object.values(movie)) {
                    if (MarkerEnum.typeMatch(markerAction.marker_type, deleteType)) {
                        this.#removeFromPurgeMap(markerAction);
                    }
                }
            }
        } else {
            for (const show of Object.values(this.#purgeCache[sectionId])) {
                for (const season of Object.values(show)) {
                    for (const episode of Object.values(season)) {
                        for (const markerAction of Object.values(episode)) {
                            if (MarkerEnum.typeMatch(markerAction.marker_type, deleteType)) {
                                this.#removeFromPurgeMap(markerAction);
                            }
                        }
                    }
                }
            }
        }

        return deleteCount;
    }
}

export { MarkerBackupManager, Instance as BackupManager, ExtraData };
