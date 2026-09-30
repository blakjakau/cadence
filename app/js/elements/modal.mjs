import { Panel } from './panel.mjs';
import { Inner } from './inner.mjs';
import { ActionBar } from './actionbar.mjs';
import { Button } from './button.mjs';
import { Input } from './input.mjs';

class Modal {
    #promiseResolve = null;
    #promiseReject = null;
    #panel = null;
    #keyListenerOn = false;
    #snapshotTaken = false; // set by snapshot() so show() skips its auto-snapshot
    #stack = []; // snapshots of previous modal content (inner + actionBar) so a
                  // nested modal (prompt/confirm) restores the one below it
    #heldToast = null; // the currently held toast element (null = none)
    #toastTimer = null; // pending auto-dismiss timer id (null = none / persistent)

    constructor() {
        this.#panel = new Panel();
        this.#panel.setAttribute('type', 'modal');
        this.#panel.setAttribute('blank', '');

        this.inner = new Inner();
        this.actionBar = new ActionBar();
        this.#panel.append(this.inner, this.actionBar);

        // Handle keyboard shortcuts
        this.keyListener = (e) => {
            if (e.key === 'Escape') {
                const cancelBtn = this.actionBar.querySelector('ui-button.cancel');
                if (cancelBtn) cancelBtn.click();
                else this.hide(false); // Resolve with false or null on escape
            } else if (e.key === 'Enter') {
                // Prevent Enter from submitting if we are inside a textarea
                if (e.target.tagName.toLowerCase() === 'textarea') return;
                
                const acceptBtn = this.actionBar.querySelector('ui-button.themed');
                if (acceptBtn) {
                    e.preventDefault();
                    acceptBtn.click();
                }
            }
        };
    }

    // Capture the currently displayed content (and the promise it belongs to)
    // so it can be restored when a nested modal closes. Call this BEFORE
    // replacing inner/actionBar content to nest a modal — the auto-snapshot
    // in show() only fires if content is still intact, so snapshotting after
    // replacement would save the new content and "restoring" it would be a
    // no-op that looks like a re-render.
    snapshot() {
        if (this.#panel.hasAttribute('active')) {
            // Only capture the bar's real buttons — not its internal
            // btnOverflow/pnlOverflow children. ActionBar.append() rejects
            // non-Button children (pnlOverflow is a Panel) and would bail
            // out without restoring anything.
            this.#stack.push({
                inner: [...this.inner.children],
                actionBar: [...this.actionBar.children].filter(
                    el => el instanceof Button && el !== this.actionBar.btnOverflow
                ),
                resolve: this.#promiseResolve
            });
            this.#snapshotTaken = true;
        }
    }

    show() {
        // If a modal is already active and no explicit snapshot() was taken
        // for this level, capture its content (and the promise it is
        // awaiting) so it can be restored when this nested modal closes —
        // e.g. a prompt opened from inside another modal returns to it
        // instead of destroying it. Each nested level gets its own snapshot;
        // levels restore in reverse order as they close.
        if (this.#panel.hasAttribute('active') && !this.#snapshotTaken) {
            this.snapshot();
        }
        this.#snapshotTaken = false;
        // Always append the panel (no-op if already in the DOM) and re-activate
        // it so a re-shown modal replays its transition.
        document.body.append(this.#panel);
        // A teeny delay to allow the element to be in the DOM for the CSS transition
        setTimeout(() => this.#panel.setAttribute('active', ''), 10);
        if (!this.#keyListenerOn) {
            document.addEventListener('keydown', this.keyListener);
            this.#keyListenerOn = true;
        }
        // Each show() returns its own promise. The previous (outer) promise's
        // resolver was saved in the snapshot above and is restored by hide()
        // when this level closes, so the outer `await show()` still settles
        // when the outer modal itself is closed.
        return new Promise((resolve, reject) => {
            this.#promiseResolve = resolve;
            this.#promiseReject = reject;
        });
    }

    hide(resolutionValue) {
        // A nested modal is closing: restore the content of the modal below
        // it and keep the panel open instead of removing it. The outer
        // modal's pending promise (from its own show() call) is restored
        // alongside the content, so its `await show()` still settles when
        // the outer modal itself is closed.
        if (this.#stack.length > 0) {
            const snapshot = this.#stack.pop();
            // Settle the nested modal's own promise (its awaiter gets the
            // value / null / false), then hand the slot back to the modal
            // below so its `await show()` still settles when it closes.
            if (this.#promiseResolve) {
                this.#promiseResolve(resolutionValue);
            }
            this.#promiseResolve = snapshot.resolve ?? null;
            this.inner.empty();
            this.actionBar.empty();
            this.inner.append(...snapshot.inner);
            this.actionBar.append(...snapshot.actionBar);
            return;
        }
        // Outermost modal closing: settle its promise and tear the panel down.
        if (this.#promiseResolve) {
            this.#promiseResolve(resolutionValue);
            this.#promiseResolve = null;
        }
        this.#panel.removeAttribute('active');
        document.removeEventListener('keydown', this.keyListener);
        this.#keyListenerOn = false;
        this.#panel.blanker.remove();
        // Let CSS animation finish before removing from DOM
        setTimeout(() => this.#panel.remove(), 300);
    }

    notice(content, title = 'Notice') {
        this.snapshot(); // capture any active modal below before replacing content
        this.inner.innerHTML = `<h1>${title}</h1>${content}`;
        this.actionBar.empty(); // Clear previous buttons

        const okButton = new Button('Ok');
        okButton.classList.add('themed');
        okButton.on('click', () => this.hide(true));
        this.actionBar.append(okButton);
        
        return this.show();
    }

    confirm(content, title = 'Confirm', buttons = ['Ok', 'Cancel']) {
        this.snapshot(); // capture any active modal below before replacing content
        this.inner.innerHTML = `<h1>${title}</h1>${content}`;
        this.actionBar.empty();

        const okButton = new Button(buttons[0]);
        okButton.classList.add('themed');
        okButton.on('click', () => this.hide(true));

        const cancelButton = new Button(buttons[1]);
        cancelButton.classList.add('cancel');
        cancelButton.on('click', () => this.hide(false));

        this.actionBar.append(okButton, cancelButton);
        
        return this.show();
    }

    prompt(content, title = 'Prompt', defaultValue = '') {
        this.snapshot(); // capture any active modal below before replacing content
        // Clear previous content
        this.inner.innerHTML = '';
        this.actionBar.empty();

        // Create and append title
        const titleElement = document.createElement('h1');
        titleElement.innerHTML = title;
        this.inner.append(titleElement);

        // Create and append content paragraph
        const contentElement = document.createElement('p');
        contentElement.innerHTML = content;
        this.inner.append(contentElement);

        // Create and append the Input custom element
        const inputElement = new Input();
        inputElement.type = 'text'; // Set type for the internal input
        inputElement.value = defaultValue;
        this.inner.append(inputElement);
        
        const okButton = new Button('Ok');
        okButton.classList.add('themed');
        
        const submit = () => {
            this.hide(inputElement.value); // Get value from the Input custom element
        }
        
        okButton.on('click', submit);

        const cancelButton = new Button('Cancel');
        cancelButton.classList.add('cancel');
        cancelButton.on('click', () => this.hide(null));

        this.actionBar.append(okButton, cancelButton);
        
        const promise = this.show(); // Show the modal panel
        setTimeout(() => inputElement.focus(), 50); // Focus the input after it's rendered
        return promise;
    }

    toast(message, duration = 3000) {
        this.clearToast(); // a new toast replaces any currently held one
        const toastEl = document.createElement('div');
        toastEl.classList.add('modal-toast');
        toastEl.textContent = message;
        toastEl.style.position = 'fixed';
        toastEl.style.bottom = '20px';
        toastEl.style.left = '50%';
        toastEl.style.transform = 'translateX(-50%)';
        toastEl.style.backgroundColor = 'var(--theme-dark, #333)';
        toastEl.style.color = '#fff';
        toastEl.style.padding = '12px 24px';
        toastEl.style.borderRadius = 'var(--radius, 8px)';
        toastEl.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        toastEl.style.zIndex = '99999';
        toastEl.style.opacity = '0';
        toastEl.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        toastEl.style.fontSize = '14px';
        // Clicking the toast dismisses it instantly (no fade-out)
        toastEl.addEventListener('click', () => {
            if (this.#heldToast !== toastEl) return;
            this.#heldToast = null;
            if (this.#toastTimer !== null) {
                clearTimeout(this.#toastTimer);
                this.#toastTimer = null;
            }
            toastEl.remove();
        });

        document.body.appendChild(toastEl);
        this.#heldToast = toastEl;

        // Fade in (only if this toast is still the held one — it may have
        // been replaced by a newer toast before the frames fired)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (this.#heldToast !== toastEl) return;
                toastEl.style.opacity = '1';
                toastEl.style.transform = 'translateX(-50%) translateY(-10px)';
            });
        });

        if (duration > 0) {
            // Auto-dismiss after `duration` ms (existing behavior for
            // duration > 0 callers)
            this.#toastTimer = setTimeout(() => {
                this.#toastTimer = null;
                if (this.#heldToast !== toastEl) return;
                this.#heldToast = null;
                toastEl.style.opacity = '0';
                toastEl.style.transform = 'translateX(-50%) translateY(10px)';
                setTimeout(() => {
                    if (toastEl.isConnected) toastEl.remove();
                }, 300);
            }, duration);
        } else {
            // duration === 0: no timer — the toast persists until it is
            // replaced by a newer toast() call or cleared explicitly
        }
    }

    clearToast() {
        // Manually remove the currently held toast and cancel any pending
        // auto-dismiss timer. No-op when nothing is held.
        if (this.#toastTimer !== null) {
            clearTimeout(this.#toastTimer);
            this.#toastTimer = null;
        }
        const el = this.#heldToast;
        this.#heldToast = null;
        if (el && el.isConnected) {
            el.style.opacity = '0';
            el.style.transform = 'translateX(-50%) translateY(10px)';
            setTimeout(() => el.remove(), 300);
        }
    }

    clearModal() {
        this.clearToast();
    }
}

const modal = new Modal

export default modal
export { modal as Modal }