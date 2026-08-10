/* Gets App Store links out of social in-app browsers.
 *
 * Instagram (and Threads, Facebook, TikTok...) open links in their own
 * WKWebView, where apps.apple.com links are intercepted and dead-end. There is
 * no documented way out, so this tries the known escapes in order and, when
 * they all fail, shows the manual exit steps instead of leaving a dead button:
 *
 *   1. the app's private extbrowser scheme, which hands the URL to Safari
 *   2. itms-apps://, which the host app usually passes to the system
 *   3. the "tap ... then Open in browser" instructions, plus copy-to-clipboard
 *
 * Steps 1 and 2 are undocumented and Meta breaks them periodically, so nothing
 * here assumes they work. Normal browsers never run any of it: the CTA is a
 * plain <a href> that already does the right thing.
 *
 * Naming the host is an enhancement, not a precondition. Telegram is the case
 * that forces this: its WebView is indistinguishable from Safari by user agent,
 * blocks the link just like Instagram does, and used to fall straight through
 * to a dead button. So step 3 runs for any iOS WebView we end up in, named or
 * not, driven by whether the hand-off actually worked rather than by who we
 * think is hosting us.
 */
(function () {
  'use strict';

  var APP_ID = '6787452888';
  var APP_STORE = 'https://apps.apple.com/app/id' + APP_ID;
  var STORE_SCHEME = 'itms-apps://apps.apple.com/app/id' + APP_ID;

  /* Private schemes registered by the apps themselves. Instagram's has been
     around for years; both are silently ignored on builds that dropped it. */
  var EXT_BROWSER = {
    instagram: 'instagram://extbrowser/?url=',
    threads: 'barcelona://extbrowser/?url='
  };

  /* How long to wait for a scheme to take us out of the app before moving on.
     Long enough that a slow hand-off is not cut short, short enough that a
     blocked one does not feel like a hang. */
  var STEP_TIMEOUT = 1200;

  /* Try the extbrowser scheme once as the page loads, so a visitor whose app
     build still honours it never has to tap anything. Set to false (or load
     the page with ?noauto=1) if a future Instagram build starts showing an
     error for the unhandled scheme instead of ignoring it. */
  var AUTO_ATTEMPT = true;

  var ua = navigator.userAgent || '';
  var isIOS = /iP(hone|od|ad)/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* Telegram is the one host that cannot be sniffed: its WebView reports a user
     agent byte-identical to Safari's, and has since at least 2022. It does
     inject these globals, which is the only reliable signal there is.
     https://github.com/TelegramMessenger/Telegram-iOS/issues/736 */
  function isTelegram() {
    return 'TelegramWebviewProxy' in window ||
      'TelegramWebviewProxyProto' in window ||
      'TelegramWebview' in window;
  }

  function detectHost() {
    if (isTelegram()) return 'telegram';
    if (/Instagram/i.test(ua)) return 'instagram';
    if (/Barcelona|Threads/i.test(ua)) return 'threads';
    /* Messenger carries the FBAN tokens too, so it has to be tested first. */
    if (/FB[\w_]+\/Messenger/i.test(ua)) return 'messenger';
    if (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua)) return 'facebook';
    if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'tiktok';
    if (/LinkedInApp/i.test(ua)) return 'linkedin';
    if (/Snapchat/i.test(ua)) return 'snapchat';
    if (/Pinterest\//i.test(ua)) return 'pinterest';
    if (/\b(WAiOS|WA4A)\//i.test(ua)) return 'whatsapp';
    if (/MicroMessenger\//i.test(ua)) return 'wechat';
    if (/\bReddit\//i.test(ua)) return 'reddit';
    if (/\bTwitter/i.test(ua)) return 'twitter';
    return '';
  }

  var NAMES = {
    instagram: 'Instagram',
    threads: 'Threads',
    facebook: 'Facebook',
    messenger: 'Messenger',
    tiktok: 'TikTok',
    linkedin: 'LinkedIn',
    snapchat: 'Snapchat',
    pinterest: 'Pinterest',
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    wechat: 'WeChat',
    reddit: 'Reddit',
    twitter: 'X'
  };

  /* The wording of the menu item differs per app. */
  var EXIT_LABEL = {
    instagram: 'Open in browser',
    threads: 'Open in browser',
    facebook: 'Open in Safari',
    messenger: 'Open in Safari',
    tiktok: 'Open in browser',
    linkedin: 'Open in Safari',
    snapchat: 'Open in Safari',
    pinterest: 'Open in browser',
    telegram: 'Open in Safari',
    whatsapp: 'Open in Safari',
    wechat: 'Open in Safari',
    reddit: 'Open in Safari',
    twitter: 'Open in Safari'
  };

  /* Only the Meta apps reliably hide the exit behind ... in the top right.
     Naming a control the visitor cannot find is worse than saying "the menu",
     so everyone else gets wording that does not point at a specific button. */
  var DOT_MENU = {
    instagram: true,
    threads: true,
    facebook: true,
    messenger: true
  };

  var host = detectHost();

  /* Real Mobile Safari reports both a Version/ and a Safari/ token; a bare
     WKWebView reports neither. */
  var looksLikeSafari = /Version\/[\d.]+/.test(ua) && /Safari\//.test(ua);

  /* Only iOS needs any of this: the link is an App Store link. */
  if (!isIOS) return;

  /* Recognising the host is an enhancement, not a precondition. An unnamed
     WebView still gets the fallback below, because the useful signal is
     whether the hand-off worked, not who is hosting us. Anything that looks
     like real Safari and is not a known host is left alone, so the plain link
     keeps working where it already works. */
  if (!host && looksLikeSafari) return;

  var noAuto = /[?&]noauto\b/.test(window.location.search);

  var cta = document.getElementById('cta');
  var panel = document.getElementById('escape');
  var ctaLabel = cta && cta.querySelector('.cta-label');
  if (!cta || !panel || !ctaLabel) return;

  var label = ctaLabel.textContent;
  var timers = [];

  /* Every attempt gets a token. Cancelling bumps it, so timers left over from
     an abandoned chain do nothing when they land. Cancelling must never latch
     permanently: a scheme that only half-fires still backgrounds the page, and
     latching there would leave the button dead when the user comes back. */
  var token = 0;
  var userTried = false;

  function cancel() {
    token++;
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
  }

  function fire(url) {
    try {
      window.location.href = url;
    } catch (err) {
      /* Blocked schemes throw in some builds; the chain moves on regardless. */
    }
  }

  function setBusy(busy) {
    cta.setAttribute('aria-busy', busy ? 'true' : 'false');
    ctaLabel.textContent = busy ? 'Opening the App Store…' : label;
  }

  var revealed = false;

  function reveal() {
    if (revealed) return;
    revealed = true;
    panel.hidden = false;
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function step(chain, i, mine) {
    if (mine !== token) return;
    if (i >= chain.length) {
      setBusy(false);
      reveal();
      return;
    }
    fire(chain[i]);
    timers.push(setTimeout(function () { step(chain, i + 1, mine); }, STEP_TIMEOUT));
  }

  function attempt() {
    cancel();
    userTried = true;
    setBusy(true);
    var chain = [];
    if (EXT_BROWSER[host]) chain.push(EXT_BROWSER[host] + encodeURIComponent(APP_STORE));
    chain.push(STORE_SCHEME);
    step(chain, 0, token);
  }

  /* Leaving the page means something worked, or at least took over. Drop the
     chain so returning to the app does not land the user mid-sequence. */
  window.addEventListener('pagehide', cancel);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancel();
      return;
    }
    /* Back on this page. If they had tapped and are still looking at us, the
       hand-off did not stick — make the button live again and show the steps. */
    setBusy(false);
    if (userTried) reveal();
  });

  cta.addEventListener('click', function (e) {
    e.preventDefault();
    attempt();
  });

  var nameSlot = document.getElementById('escape-app');
  var exitSlot = document.getElementById('escape-exit');
  var menuSlot = document.getElementById('escape-menu');
  if (nameSlot) nameSlot.textContent = NAMES[host] || 'This app';
  if (exitSlot) exitSlot.textContent = EXIT_LABEL[host] || 'Open in browser';
  if (menuSlot && !DOT_MENU[host]) menuSlot.textContent = 'Open this browser’s menu.';

  var copy = document.getElementById('copy');
  if (copy) {
    copy.hidden = false;
    copy.addEventListener('click', function () {
      function done() {
        copy.textContent = 'Link copied';
        setTimeout(function () { copy.textContent = 'Copy the App Store link'; }, 2000);
      }
      function legacyCopy() {
        var field = document.createElement('textarea');
        field.value = APP_STORE;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        field.setSelectionRange(0, APP_STORE.length);
        try { document.execCommand('copy'); done(); } catch (err) { /* nothing left to try */ }
        document.body.removeChild(field);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(APP_STORE).then(done, legacyCopy);
      } else {
        legacyCopy();
      }
    });
  }

  /* What to fire on load, per host. Only hosts whose hand-off has actually
     been watched to work get one. A scheme the host ignores costs nothing, but
     one it rejects can raise an error dialog, and that is worse than simply
     showing the page — so this list grows only on device evidence.
       instagram, threads: the private extbrowser scheme.
       telegram: no escape scheme exists for it, but itms-apps:// does reach
       the App Store from its WebView, so it needs no escape. */
  function autoUrl() {
    if (EXT_BROWSER[host]) return EXT_BROWSER[host] + encodeURIComponent(APP_STORE);
    if (host === 'telegram') return STORE_SCHEME;
    return '';
  }

  /* One free attempt on load. If it works the user never has to tap anything;
     if it does not, nothing visible happens. */
  var auto = autoUrl();
  if (AUTO_ATTEMPT && auto && !noAuto) {
    var mine = token;
    timers.push(setTimeout(function () {
      if (mine === token) fire(auto);
    }, 300));
  }
})();
