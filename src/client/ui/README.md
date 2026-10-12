# BrowSDR UI components

This is the shared UI layer for receiver and workspace features. Import from
`src/client/ui/index.ts` and register components in the Vue Options API
`components` option. The receiver already registers the full set.

Components and stories are grouped under `controls/`, `layout/`, `feedback/`,
`dialogs/`, `indicators/`, and `menus/`. Keep related stories alongside their components.
See the [code quality guide](../../../docs/code-quality.md) for checks and limits.

The existing `src/client/style.css` supplies all component styling, including
mobile breakpoints. Components render the same native tags, classes, and nesting
as the original UI. Do not add a second theme or duplicate these styles in
components. Storybook imports the same stylesheet and fonts; its small preview
stylesheet only lets the canvas page scroll.

## Development and checks

```sh
npm run storybook         # http://localhost:6006
npm run build:storybook   # standalone catalog in storybook-static/
npm run test:ui           # component behavior in jsdom
npx playwright install chromium # once, before browser tests
npm run test:storybook    # render every story and run its play function
npm run typecheck
```

`npm test -- --run` includes UI component tests alongside the existing client and
Workers projects. Storybook browser tests run separately so the ordinary test
suite does not require an installed browser. CI runs both and uploads the built
catalog as an artifact. To use an already installed Chrome or Edge locally, set
`PLAYWRIGHT_CHANNEL=chrome` or `PLAYWRIGHT_CHANNEL=msedge` before running browser
tests (PowerShell: `$env:PLAYWRIGHT_CHANNEL='msedge'`).

## Component contracts

| Component            | Props / variants                                                                                           | Intended use                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `UiButton`           | `variant`, `type`, `disabled`, `title`; `click` event                                                      | All actions, including toolbar icons, bookmark actions, tabs, and device rows             |
| `UiInput`            | `modelValue`, `type`; supports `.number`, `.trim`, `.lazy`                                                 | Native text, numeric, search, and range inputs                                            |
| `UiSelect`           | `modelValue`; `.number`; option/optgroup slot                                                              | Native selects, including device-generated options                                        |
| `UiCheckbox`         | `v-model`, custom/native `variant`, `trueValue`/`falseValue`, `label`, `disabled`, `inputId`, `inputLabel` | Existing custom checkbox and numeric device switches; `change` fires after model update   |
| `UiRadio`            | `v-model`, `value`, `name`, `label`, `disabled`                                                            | Existing mode radio; use a receiver-specific group name                                   |
| `UiFormRow`          | `label`, `inputId`; default slot                                                                           | Form row, with optional associated label; extra classes/styles pass through               |
| `UiInputGroup`       | `unit`; default slot                                                                                       | Existing input enclosure with optional unit suffix                                        |
| `UiSlider`           | numeric `v-model`, `min`, `max`, `step`, `disabled`, `compact`, `inputLabel`, `valueText`                  | Slider with value readout; slot overrides readout formatting                              |
| `UiSpinbox`          | `v-model`, `step`, optional `min`/`max`, `disabled`, `inputLabel`                                          | Numeric input with minus/plus buttons                                                     |
| `UiPanel`            | `v-model:collapsed`, `label`, `disabled`, `outOfBand`, `condensed`, `collapsible`                          | Standard sidebar panel; `header` slot overrides title; collapse preserves mounted content |
| `UiPanelHeader`      | `collapsed`, `label`, `showChevron`, `collapsible`; `toggle` event                                         | Custom panel structures such as VFO action headers and bookmarks                          |
| `UiChevron`          | `collapsed`, `size`                                                                                        | Shared collapse indicator                                                                 |
| `UiDialog`           | `open`, `title`, `variant`, `bodyVariant` (padded/flush), `dismissible`; `close` event                     | Existing dialog shell; `title`, default body, and `footer` slots                          |
| `UiFrequencyDisplay` | string `v-model`, `index`, `color`, `active`, `receiving`, `enabled`, `outOfBand`, `bookmark`              | Header frequency display; `select`, `focus`, `apply` events                               |
| `UiLock`             | `locked`, `host`; `toggle` event                                                                           | Host-controlled lock indicator; client cannot toggle                                      |
| `UiBadge`            | `variant`; default slot                                                                                    | Decoder states, bookmark types/categories, remote status                                  |
| `UiSnackbar`         | `show`, `message`                                                                                          | Existing toast with a polite live announcement                                            |
| `UiNotice`           | `title`, `message`, `href`, `linkLabel`; default slot                                                      | Persistent capability guidance with an optional external help link                        |
| `UiToolHeader`       | `variant`: transcript, pocsag, activity; `actions` slot                                                    | Decoder/tool title and toolbar, including RDS and rtl_433                                 |
| `UiEmptyState`       | `variant`: bookmark, transcript, pocsag, activity, remote-clients                                          | Existing empty-state treatment                                                            |

Button variants are declared in `UiButton.ts` and shown together in **UI / Button /
All Variants**. Dialog and badge variant maps live with their components. Active
and domain-specific state classes can still be bound on the component, as with
the old native elements. Attributes and native input events pass through; the
input/select components use Vue's own model directives to preserve conversion,
composition, and event ordering.

Tool headers accept `closable` and `closeLabel` and emit `close`. Use these for
panel dismissal; the close button aligns with desktop actions and stays pinned
at the top right on mobile, outside the wrapping actions slot. Closing a tool
should preserve its decoder settings.

`UiMenu` provides a labeled action disclosure using the existing icon button
treatment. Supply a receiver-specific `id` and groups of items with `id`, `label`,
`description` and `icon`; handle its `select` event in the application. An item's
`active` state uses the red tool accent, while `open` describes panel visibility
through `aria-pressed`. Selection, Escape, outside clicks and focus leaving the
disclosure close it; selection and Escape restore focus to the trigger. Groups
use two columns on desktop and one on mobile. See **UI / Menu / Grouped**.

`UiIcon` supplies the approved Lucide tool symbols from `@lucide/vue` with `name` and optional
`size` (24px by default). It is decorative; put the accessible label on the
containing control. See **UI / Tool Icons / All**.

The receiver's Tools menu remains available at every width. Enabled decoders
also appear once each as labeled desktop shortcuts, independent of whether
their panels are open. These shortcuts open panels without changing decoding
and are hidden in the mobile header. Closing a panel preserves its shortcut and
configuration. RDS is active only when a WFM VFO has RDS enabled; its saved setting
on other modes does not activate the menu item or shortcut. Wireless Sensors is the product label; rtl_433 stays in its menu
description. Toolbar state belongs to `app/workspace/receiver-tools.ts` so decoder
telemetry does not invalidate the toolbar or unrelated VFO controls.

Dialog body layout is separate from the dialog's visual variant. The default
`bodyVariant="padded"` retains the normal responsive form spacing. Use
`bodyVariant="flush"` for lists whose rows provide their own padding, such as Add
SDR. This removes body padding at all viewport sizes; the title and footer keep
their existing spacing. Prefer this shared layout option over inline padding
overrides or a dialog variant tied to a single feature.

## Adding features

```html
<UiPanel label="Radio" v-model:collapsed="collapsedPanels.radio">
	<UiFormRow label="Center" :input-id="receiverId + '-center'">
		<UiInputGroup unit="MHz">
			<UiInput :id="receiverId + '-center'" type="number" v-model.number="radio.centerFreq" step="0.1" />
		</UiInputGroup>
	</UiFormRow>
</UiPanel>
```

Keep receiver state, hardware commands, and decoder logic in the application
modules. Shared components accept props and emit events; they do not start USB,
WebRTC, audio, AI models, or workers. Native file inputs and the bookmark name
input remain in receiver slots because existing code needs their DOM refs.

Add a story for every new visual variant, including disabled and active states
where applicable. Use a story `play` function for meaningful user interactions,
and add component tests when state/event contracts need protection. Compare
desktop and mobile output whenever changing markup or styles; existing styling
is the reference appearance.

`UiMenu` also supports a split action through `primaryLabel` and the `primary`
event. The primary button runs the caller's default action; the chevron opens a
single-column list of alternative actions. `label` names the disclosure for
assistive technology. `disabled` disables both triggers and the listed actions.
See **UI / Menu / Split Action** and **Split Disabled**. Auto set gains uses this
variant: the main button always runs Balanced, while menu choices run once and
do not change the main button's default.
