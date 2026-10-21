// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the access point and its tags, at every start and whenever a
  // tag appears or is renamed; a scan publishes them again.
  gladys.onScanRequest(() => app.publishDevices({ force: true }));
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Scene action: show a text on a tag. A failure is logged here: the SDK
  // only acks it to the scene.
  gladys.onSceneAction(SCENE_ACTIONS.SHOW_TEXT, async (fields) => {
    try {
      return await app.showText(fields);
    } catch (err) {
      logger?.warn(`Show a text failed: ${err.message}`);
      throw err;
    }
  });

  // Configuration screen button.
  gladys.onAction(ACTIONS.RECONNECT, () => app.reconnect());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.start(config));

  // Connection lifecycle (also after every reconnection to Gladys).
  gladys.on('connected', async () => {
    try {
      await app.start(await gladys.getConfig(), { connected: true });
    } catch (err) {
      logger?.error('Start failed', err);
    }
  });
}
