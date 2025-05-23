import { $, $$, $append, $div, $span, addEventsToElement  } from './HtmlHelpers.js';
import { ContextualLog } from '/Shared/ConsoleLog.js';
import { toggleVisibility } from './Common.js';

import { addWindowResizedListener, isSmallScreen } from './WindowResizeEventHandler.js';
import { Attributes } from './DataAttributes.js';
import { getSvgIcon } from './SVGHelper.js';
import Icons from './Icons.js';
import { ThemeColors } from './ThemeColors.js';
import Tooltip from './Tooltip.js';

/** @typedef {!import('./SVGHelper.js').SVGAttributes} SVGAttributes */
/** @typedef {!import('./Icons').IconKeys} IconKeys */
/** @typedef {!import('./ThemeColors').ThemeColorKeys} ThemeColorKeys */

/** @typedef {{[attribute: string]: string}} AttributeMap */

const Log = ContextualLog.Create('ButtonCreator');

/**
 * A static class that creates various buttons used throughout the app.
 */
class ButtonCreator {

    /**
     * One-time setup that initializes the window resize event listener that determines whether to show
     * text labels for dynamic buttons. */
    static Setup() {
        addWindowResizedListener(() => {
            const small = isSmallScreen();
            $('.button.resizable').forEach((button) => {
                const reverse = button.classList.contains('reverse');
                const showText = small === reverse;
                const buttonText = $$('.buttonText', button);
                toggleVisibility(buttonText, showText);

                // Don't override the tooltip if it was user-set.
                if (!button.hasAttribute(Attributes.UseDefaultTooltip)) {
                    return;
                }

                if (showText) {
                    Tooltip.removeTooltip(button);
                } else {
                    Tooltip.setTooltip(button, buttonText.innerText);
                }

            });
        });
    }

    /**
     * Creates a tabbable button with an associated icon and text.
     * @param {string} text The text of the button.
     * @param {keyof IconKeys} icon The icon to use.
     * @param {keyof ThemeColors} color The theme color of the icon.
     * @param {EventListener} clickHandler The callback to invoke when the button is clicked.
     * @param {AttributeMap} attributes Additional attributes to set on the button. */
    static fullButton(text, icon, color, clickHandler, attributes={}) {
        const [mainAttrib, svgAttrib] = ButtonCreator.#extractAttributes(attributes);
        const button = ButtonCreator.#tableButtonHolder('buttonIconAndText', clickHandler, mainAttrib);
        return $append(button,
            getSvgIcon(icon, color, svgAttrib),
            $span(text, { class : 'buttonText' }));
    }

    /**
     * Creates a tabbable button with the associated icon and text. On small-width devices, hides the text.
     * @param {string} text The text of the button.
     * @param {keyof IconKeys} icon The icon to use.
     * @param {keyof ThemeColorKeys} color The theme color of the icon.
     * @param {EventListener} clickHandler The callback to invoke when the button is clicked.
     * @param {AttributeMap} attributes Additional attributes to set on the button. */
    static dynamicButton(text, icon, color, clickHandler, attributes={}, reverse=false) {
        const className = 'resizable' + (reverse ? ' reverse' : '');
        if (attributes.class) {
            attributes.class += ' ' + className;
        } else {
            attributes.class = className;
        }

        const button = ButtonCreator.fullButton(text, icon, color, clickHandler, attributes);
        if (!attributes.tooltip) {
            button.setAttribute(Attributes.UseDefaultTooltip, 1);
        }

        if (isSmallScreen() !== reverse) {
            $$('.buttonText', button).classList.add('hidden');
            if (!attributes.tooltip) {
                Tooltip.setTooltip(button, text);
            }
        }

        return button;
    }

    /**
     * Creates a button with only an icon, no associated label text.
     * @param {keyof IconKeys} icon The name of the icon to add to the button.
     * @param {string} altText The alt text for the icon image.
     * @param {keyof ThemeColorKeys} color The color of the icon, as a hex string (without the leading '#')
     * @param {EventListener} clickHandler The button callback when its clicked.
     * @param {AttributeMap} attributes Additional attributes to set on the button. */
    static iconButton(icon, altText, color, clickHandler, attributes={}) {
        if (!attributes.title && !attributes.tooltip) { // Don't let title and custom tooltip clash
            attributes.tooltip = altText;
        }

        const [mainAttrib, svgAttrib] = ButtonCreator.#extractAttributes(attributes);
        const button = ButtonCreator.#tableButtonHolder('buttonIconOnly', clickHandler, mainAttrib);
        return $append(button, getSvgIcon(icon, color, svgAttrib));
    }

    /**
     * Creates a tabbable button that doesn't have an icon.
     * @param {string} text The text of the button.
     * @param {EventListener} clickHandler The button callback when its clicked.
     * @param {AttributeMap} [attributes={}] Additional attributes to set on the button. */
    static textButton(text, clickHandler, attributes={}) {
        const button = ButtonCreator.#tableButtonHolder('buttonTextOnly', clickHandler, attributes);
        return $append(button, $span(text, { class : 'buttonText' }));
    }

    /**
     * Return a loading icon animation. Doesn't belong here, since we don't wrap
     * this in our button logic, returning a "raw" image.
     * @param {number} size
     * @param {SVGAttributes} attributes
     * @param {keyof ThemeColorKeys} color */
    static loadingIcon(size=20, attributes, color=ThemeColors.Primary) {
        return getSvgIcon(Icons.Loading, color, { width : size, height : size, ...attributes });
    }

    /**
     * Sets the text of the given button.
     * @param {HTMLElement} button
     * @param {string} newText */
    static setText(button, newText) {
        // No-op if this isn't a text button
        const span = $$('.buttonText', button);
        if (!span) {
            return;
        }

        span.innerText = newText;
    }

    /**
     * Sets the icon of the given button.
     * @param {HTMLElement} button
     * @param {keyof IconKeys} newIcon
     * @param {keyof ThemeColorKeys} theme */
    static setIcon(button, newIcon, theme) {
        const svg = $$('svg', button);
        if (!svg) {
            Log.warn('Called setIcon on non-icon button!');
        }

        const attrib = { width : svg.getAttribute('width') || 20, height : svg.getAttribute('height') || 20 };
        svg.replaceWith(getSvgIcon(newIcon, theme, attrib));
    }

    /**
     * Return the button, or undefined if the element is not part of a button.
     * @param {HTMLElement} element */
    static getButton(element) {
        let current = element;
        while (current && !current.classList.contains('button')) {
            current = current.parentElement;
        }

        return current;
    }

    /**
     * Returns an empty button with the given class
     * @param {string} className The class name to give this button.
     * @param {EventListener} clickHandler The callback function when the button is clicked.
     * @param {AttributeMap} attributes Additional attributes to set on the button. */
    static #tableButtonHolder(className, clickHandler, attributes) {
        const button = $div(
            { class : `button noSelect ${className}`, tabindex : '0' },
            0,
            { keydown : ButtonCreator.#tableButtonKeydown });

        // Add click handler after initial create, since we want to pass in the button itself.
        // We do this because sometimes we want to act on this button, and e.target might be an
        // inner element of this "button", and it's better to have direct access to it instead of
        // reaching into the internals of the button to grab the right button div.
        button.addEventListener('click', (e) => {
            // Disabled buttons don't do anything.
            if (!button.classList.contains('disabled')) {
                clickHandler(e, button);
            }
        });

        for (const [attribute, value] of Object.entries(attributes)) {
            if (attribute === 'class') { // Don't clash with the other classes set above.
                for (const singleClass of value.split(' ')) {
                    button.classList.add(singleClass);
                }
            } else if (attribute === 'tooltip') {
                Tooltip.setTooltip(button, value);
            } else if (attribute === 'events') {
                // Extra events outside of the standard click event
                addEventsToElement(button, value);
            } else if (attribute === 'auxclick' && value) {
                button.addEventListener('auxclick', (e) => {
                    // Disabled buttons don't do anything.
                    if (!button.classList.contains('disabled')) {
                        clickHandler(e, button);
                    }
                });
            } else {
                button.setAttribute(attribute, value);
            }
        }

        return button;
    }

    /**
     * Treat 'Enter' on a table "button" as a click.
     * @param {KeyboardEvent} e */
    static #tableButtonKeydown(e) {
        // Only care about 'Enter', and don't send multiple 'click' events
        // if someone's holding down a key.
        if (e.key !== 'Enter' || e.repeat) {
            return;
        }

        e.preventDefault();

        // For now, click target is either the button itself or the inner image/text, if available.
        // Extract the "real" button based on those assumptions.
        /** @type {HTMLElement} */
        let button = e.target;
        if (button.tagName !== 'DIV') {
            button = button.parentNode;
        }

        // Don't send a raw .click(), but dispatch a new MouseEvent
        // to ensure we properly capture any modifier key states.
        const mouseEvent = new MouseEvent('click', {
            ctrlKey : e.ctrlKey,
            shiftKey : e.shiftKey,
            altKey : e.altKey,
            metaKey : e.metaKey
        });

        button.dispatchEvent(mouseEvent);
    }

    /**
     * @param {AttributeMap} attributes */
    static #extractAttributes(attributes={}) {
        const mainAttrib = {};
        const svgAttrib = {};
        for (const [key, value] of Object.entries(attributes)) {
            if (key.startsWith('svg-')) {
                svgAttrib[key.slice(4)] = value;
            } else {
                mainAttrib[key] = value;
            }
        }

        // Default to 20x20 if not specified
        // A CSS approach would be better, but something like:
        //   .button>svg { width: 20px; height: 20px; }
        // overrides any direct <svg width="x" height="y"> attributes,
        // so only use direct attributes.
        svgAttrib.width ??= 20;
        svgAttrib.height ??= 20;
        return [mainAttrib, svgAttrib];
    }
}

export default ButtonCreator;
