import type { uiComponents } from "./components/ui";
declare module "vue" {
  export interface GlobalComponents {
    UiButton: typeof uiComponents.UiButton;
    UiInput: typeof uiComponents.UiInput;
    UiSelect: typeof uiComponents.UiSelect;
    UiFieldset: typeof uiComponents.UiFieldset;
    UiTable: typeof uiComponents.UiTable;
    UiTag: typeof uiComponents.UiTag;
    UiAlert: typeof uiComponents.UiAlert;
  }
}
export {};
