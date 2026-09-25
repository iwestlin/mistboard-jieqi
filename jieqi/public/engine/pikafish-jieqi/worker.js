/* PikaJieQi browser UCI worker. The generated Emscripten module uses this same
 * script URL for its pthread workers through mainScriptUrlOrBlob. */

let command = null;

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (message?.type === 'init') {
    try {
      importScripts(message.jsUrl);
      const factory = self.PikaJieQi;
      if (typeof factory !== 'function') {
        throw new Error('PikaJieQi factory missing after script load');
      }
      const module = await factory({
        locateFile: (file) => (file.endsWith('.wasm') ? message.wasmUrl : file),
        mainScriptUrlOrBlob: message.jsUrl,
        print: (line) => self.postMessage({ type: 'line', line: String(line) }),
        printErr: (line) => self.postMessage({ type: 'stderr', line: String(line) }),
      });
      const initialize = module.cwrap('pikajieqi_initialize', null, []);
      command = module.cwrap('pikajieqi_command', null, ['string']);
      initialize();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (message?.type === 'command' && typeof message.command === 'string') {
    if (!command) {
      self.postMessage({ type: 'error', error: 'PikaJieQi worker is not ready' });
      return;
    }
    command(message.command);
  }
});
