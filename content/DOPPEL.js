// Overridden requests are sent from here so the Network tab Initiator column shows DOPPEL.js.
Object.defineProperty(window, Symbol.for('apiov.send'), {
  value(fetchFn, input, init) {
    return fetchFn.call(window, input, init);
  }
});
