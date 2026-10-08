# Multi-VFO UI regression

Compared `main` (`1249251`) with `e1f38fdda23a71e3b0962ba361118978928e91e9`, using the supplied 27 enabled DSD VFOs.

## Cause

The UI component migration in `adc4b8e` put many component instances and dynamic slots inside the receiver's VFO loop. DSD telemetry was still read by the receiver's render function. Updating one `dsdStatus[index]` invalidated that entire function, including the controls and slots of every VFO. Even collapsed panels remained mounted with `v-show` and did this work.

DSD status is coalesced to one update per 200 ms **per VFO**. With 27 VFOs the receiver can therefore render 135 times per second. Receiver statistics, audio activity, and pointer movement also invalidate the receiver. This consumes the main thread time used for interaction, spectrum rendering, and Web Audio scheduling. The DSD decoder and shared channelizer were not changed by this fix.

## Fix

Move the existing VFO panel markup into `VfoPanel`. Inject the receiver and read per-index telemetry inside each panel's render effect. Pass the VFO object and its current index as stable props. Updating a decoder now renders the affected panel, while receiver statistics no longer render any VFO panel. Configuration editing, removal, and index shifts continue to use the receiver's existing methods.

Also keep paired `USBDevice` objects raw when adding them to the reactive device picker. Vue otherwise proxies these handles and the workspace's `paired.indexOf(device)` fails with “SDR is no longer connected.” This is a separate connection bug encountered during live verification.

## Measurements

A temporary Vitest/jsdom diagnostic mounted each actual template with all 27 supplied VFOs expanded. It applied 135 DMR status snapshots in round-robin order, awaiting Vue's update flush after each snapshot. Component `updated` hooks counted UI updates. These measure UI flush costs, not browser frame rate or total DSP throughput.

| Template | Mean UI flush | UI component updates for 135 snapshots |
| --- | ---: | ---: |
| Working commit | 5.59 ms | 0 (native controls) |
| Original main | 12.70 ms | 76,545 |
| Fixed main | 0.55 ms | 1,620 |

The original main incurred about 2.3× the working commit's UI flush cost. The fix reduced that cost by about 23× and component updates by 98%. Timing varies by machine and run. Permanent tests assert which panels update rather than using timing thresholds.

Live verification used `http://localhost:5173/`, the attached LimeSDR-USB on RX1/LNAL, center 439 MHz, 61.44 MSPS, shared channelization enabled, and the exact 27 supplied frequencies. A fixed-build stats snapshot showed 57 FPS, 62.06 MSa/s input, zero reported drops, and 27 VFOs sharing 13 bands at 1.92 MSPS. DMR burst counts advanced and decoded voice activity appeared. The original main also reached 60 FPS in a later, quieter comparison window: continuous lag was not reproduced in that window. The controlled UI diagnostic establishes the regression independently of changing RF activity.

## Regression coverage

`test/ui/receiver.spec.ts` verifies that a decoder update refreshes only its VFO panel, receiver stats refresh no VFO panels, controls and telemetry retain their current index after removal, and the USB picker preserves the paired device's identity.

`test/ui/vfo-performance.spec.ts` replays 135 separately flushed DSD status updates across the supplied 27 frequencies, with all panels expanded and again with all panels collapsed. It asserts that each snapshot updates only the affected panel and its descendants, and never updates the receiver. Another test exercises receiver stats, audio activity, and pointer telemetry while asserting that no VFO controls update. The tests use render ownership and counts instead of elapsed-time thresholds, so slow CI machines do not cause false failures. They require no SDR or browser installation.

Run `npm run test:performance` for these checks, or `npm run test:ui` for the full UI suite. The UI workflow runs the performance checks as a separate GitHub Actions job on pushes and pull requests targeting either `main` or `master`.
