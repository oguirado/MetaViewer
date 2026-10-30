/** Kit UI exports have published types; avoid checking its unrelated demos. */
declare module 'capsule-ui-kit/ui' {
  export const UiTextInput: typeof import('../.kit/capsule-ui-kit/types/ui.js').UiTextInput;
  export const UiButton: typeof import('../.kit/capsule-ui-kit/types/ui.js').UiButton;
}
