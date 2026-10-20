/**
 * WebCheat bridge — ISOLATED world.
 *
 * The MAIN-world agent cannot access chrome.* APIs, and the extension page
 * cannot enter the page's JavaScript realm. This file connects the two:
 *
 *   panel --(chrome.runtime)--> service worker --(tabs.sendMessage)--> bridge
 *   bridge --(window.postMessage)--> agent --(window.postMessage)--> bridge
 */
(function () {
  'use strict';

  var pending = Object.create(null);
  var seq = 0;

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__wce !== 'res') return;
    var p = pending[d.id];
    if (!p) return;
    delete pending[d.id];
    clearTimeout(p.timer);
    p.resolve(d.response);
  });

  function callAgent(payload) {
    return new Promise(function (resolve) {
      var id = ++seq;
      pending[id] = {
        resolve: resolve,
        timer: setTimeout(function () {
          delete pending[id];
          resolve({ error: 'agent did not respond (reload the page)' });
        }, 15000)
      };
      window.postMessage({ __wce: 'req', id: id, payload: JSON.stringify(payload) }, '*');
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.__wce !== 'rpc') return;
    callAgent(msg.payload).then(sendResponse);
    return true; // asynchronous response
  });
})();
