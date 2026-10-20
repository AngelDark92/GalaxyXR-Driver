// Explicit custom-element registry (Lit frontend, 2026-09-20 migration).
//
// Why this exists: the app's pages/controls/shell register their elements via
// Lit's @customElement decorator, and the Fluent elements via FAST's
// `Element.define`. A bare side-effect import of those modules is dropped by
// the production bundler's tree-shaker — the decorator/define registration is
// a side effect it does not reliably track — so the elements are never defined
// at runtime and the whole component subtree (including Lit) vanishes from the
// bundle. Importing the element CLASSES here (used bindings) keeps every
// defining module, and the explicit registrations below guarantee the elements
// are defined regardless of how the bundler handles the decorators.
import {
  Tablist, TablistDefinition,
  Tab, TabDefinition,
  Switch, SwitchDefinition,
  Dropdown, DropdownDefinition,
  DropdownOption, DropdownOptionDefinition,
  Listbox, ListboxDefinition,
  Slider, SliderDefinition,
  Button, ButtonDefinition,
  Badge, BadgeDefinition,
  MessageBar, MessageBarDefinition,
  Dialog, DialogDefinition,
  DialogBody, DialogBodyDefinition,
  Accordion, AccordionDefinition,
  AccordionItem, AccordionItemDefinition,
  Spinner, SpinnerDefinition,
} from '@fluentui/web-components';
import { DriverEnableBanner } from './features/driver-banner';
import { DriverTroubleshooter, SystemReady } from './features/system-ready';
import { StreamFrameCurve } from './features/curve-editor';
import { BitrateCurvePanel } from './features/bitrate-curve';
import { AppShell } from './shell/app-shell';
import { DriverSettingsPage } from './features/driver-settings-page';
import { DistortionProfilePage } from './features/distortion-profile-page';
import { StreamFramePage } from './features/stream-frame-page';
import { AppSettingsPage } from './features/app-settings-page';
import { DebugPage } from './features/debug-page';
import { SetupPage } from './features/setup-page';
import { AboutPage } from './features/about-page';
import {
  AppSwitch,
  AppSelect,
  AppNumber,
  AppSlider,
  AppSection,
  AppFieldTip,
  AppReset,
} from './ui/controls';

// Register the Fluent elements the app renders. FAST's `Class.define(definition)`
// both attaches the element's definition (template + styles + attributes) to the
// class and calls `customElements.define`; these are used expressions so they
// survive tree-shaking (a bare side-effect import of the package's no-export
// `define.js` modules is dropped even though the package lists them in
// `sideEffects`).
Tablist.define(TablistDefinition);
Tab.define(TabDefinition);
Switch.define(SwitchDefinition);
Dropdown.define(DropdownDefinition);
DropdownOption.define(DropdownOptionDefinition);
// fluent-listbox is required by fluent-dropdown: it finds the slotted *-listbox
// element (slotchangeHandler) to drive selection, so it must be defined too.
Listbox.define(ListboxDefinition);
Slider.define(SliderDefinition);
Button.define(ButtonDefinition);
Badge.define(BadgeDefinition);
MessageBar.define(MessageBarDefinition);
Dialog.define(DialogDefinition);
DialogBody.define(DialogBodyDefinition);
Accordion.define(AccordionDefinition);
AccordionItem.define(AccordionItemDefinition);
Spinner.define(SpinnerDefinition);

// Referencing every app element class keeps its defining module (and its
// @customElement registration) in the bundle.
export const appCustomElements = {
  // Fluent (classes + definitions, kept as used bindings)
  Tablist, TablistDefinition,
  Tab, TabDefinition,
  Switch, SwitchDefinition,
  Dropdown, DropdownDefinition,
  DropdownOption, DropdownOptionDefinition,
  Listbox, ListboxDefinition,
  Slider, SliderDefinition,
  Button, ButtonDefinition,
  Badge, BadgeDefinition,
  MessageBar, MessageBarDefinition,
  Dialog, DialogDefinition,
  DialogBody, DialogBodyDefinition,
  Accordion, AccordionDefinition,
  AccordionItem, AccordionItemDefinition,
  Spinner, SpinnerDefinition,
  // App shell + pages
  AppShell,
  DriverSettingsPage,
  DistortionProfilePage,
  StreamFramePage,
  AppSettingsPage,
  DebugPage,
  SetupPage,
  AboutPage,
  // Nested helpers are used only by tag name in templates.
  DriverEnableBanner, DriverTroubleshooter, SystemReady, StreamFrameCurve, BitrateCurvePanel,
  // Controls
  AppSwitch,
  AppSelect,
  AppNumber,
  AppSlider,
  AppSection,
  AppFieldTip,
  AppReset,
};
