// Was the last thing the user did a keypress or a pointer?
//
// Radix returns focus to the trigger when a menu, select or dialog closes.
// Browsers treat that programmatic focus as keyboard-driven, so the trigger
// lights up with a focus ring after a plain mouse click and keeps it until you
// click elsewhere — the "sticky focus" every Radix app hits.
//
// NoStickyFocus (components/no-sticky-focus.tsx) drops pointer focus on
// pointerup, which covers plain buttons, but it cannot cover this one: Radix
// restores focus AFTER the overlay closes, which is after that microtask has
// already run. So the trigger is re-focused once nothing is left to blur it.
//
// Suppressing the focus return outright would strand keyboard users on <body>,
// so the return is conditional: keep it when the user is on the keyboard, skip
// it when they are not.
//
// One module-level listener pair rather than per-component state: this is a
// property of the session, every overlay asks the same question, and it must be
// readable synchronously inside an event handler.

let lastInputWasKeyboard = false

if (typeof window !== "undefined") {
  // Capture phase, so a handler that stops propagation cannot desync this.
  window.addEventListener("keydown", () => (lastInputWasKeyboard = true), true)
  window.addEventListener("pointerdown", () => (lastInputWasKeyboard = false), true)
}

export function wasKeyboardInput() {
  return lastInputWasKeyboard
}

/** Radix `onCloseAutoFocus`: return focus for the keyboard, skip it for a mouse. */
export function preventFocusReturnOnPointer(e: Event) {
  if (!wasKeyboardInput()) e.preventDefault()
}
