// Overridden requests are sent from this file on purpose: Chrome's
// Network tab → Initiator column then shows "DOPPEL.js" for every
// request Doppel is overriding (normal requests keep their own initiator).
Object.defineProperty(window, Symbol.for('apiov.send'), {
  value: function (fetchFn, input, init) { return fetchFn.call(window, input, init); }
});
