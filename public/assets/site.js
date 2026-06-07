(function(){
  "use strict";

  /* ============================================================
     MODES — the single source of truth for the dual (and future
     multi-) mode experience. Add an entry here + a matching content
     panel + a CSS palette block to introduce a THIRD audience.
     `default:true` marks the no-JS / skip fallback mode.
     ============================================================ */
  var MODES = {
    business: {
      id: 'business',
      label: 'Business',
      label_es: 'Negocios',
      toggleIcon: '🏪',
      gateIcon: '🏪',
      gateTitle: 'I run a business',
      gateTitle_es: 'Tengo un negocio',
      gateBody: 'Shops, online stores, local businesses and the pros behind them. A calm, professional site that earns trust.',
      gateBody_es: 'Comercios, tiendas online, negocios locales y los profesionales detrás de ellos. Un sitio sereno y profesional que se gana la confianza.',
      gateGo: 'Show me the business studio',
      gateGo_es: 'Muéstrame el estudio para negocios',
      default: true
    },
    performer: {
      id: 'performer',
      label: 'Performer',
      label_es: 'Artista',
      toggleIcon: '🎤',
      gateIcon: '🎤',
      gateTitle: 'I am a performer',
      gateTitle_es: 'Soy artista',
      gateBody: 'Comedians, musicians and creators. Name-in-lights energy with shows, clips and a booking form.',
      gateBody_es: 'Comediantes, músicos y creadores. Energía de nombre en luces, con shows, clips y un formulario de contratación.',
      gateGo: 'Put my name in lights',
      gateGo_es: 'Pon mi nombre en luces'
    }
  };
  var ORDER = Object.keys(MODES);
  var DEFAULT_MODE = ORDER.filter(function(k){ return MODES[k].default; })[0] || ORDER[0];
  var STORAGE_KEY = 'bb-mode';
  var LANG_KEY = 'bb-lang';
  var DEFAULT_LANG = 'en';

  var docEl = document.documentElement;
  var mainEl = document.getElementById('main');
  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- safe storage helpers ---------- */
  function readMode(){
    try { return localStorage.getItem(STORAGE_KEY); } catch(e){ return null; }
  }
  function saveMode(m){
    try { localStorage.setItem(STORAGE_KEY, m); } catch(e){ /* private mode — fine */ }
  }
  function readLang(){
    try { var v = localStorage.getItem(LANG_KEY); return (v === 'es' || v === 'en') ? v : null; } catch(e){ return null; }
  }
  function saveLang(l){
    try { localStorage.setItem(LANG_KEY, l); } catch(e){ /* private mode — fine */ }
  }

  /* current language (resolved at boot, before any copy-dependent build) */
  var LANG = readLang() || DEFAULT_LANG;

  /* footer year (re-applied after any innerHTML swap of its container) */
  function setYear(){ var y = document.getElementById('year'); if (y) y.textContent = new Date().getFullYear(); }
  setYear();

  /* ============================================================
     BUILD: gate choice cards + header toggle, from the MODES map
     ============================================================ */
  var choicesEl = document.getElementById('gate-choices');
  var toggleEl = document.getElementById('mode-toggle');

  /* tiny HTML escaper for text injected into attributes/markup */
  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* the gate cards + toggle labels are JS-built, so they hold BOTH languages
     as data-es / data-en and are swapped by applyLang() like any other node. */
  ORDER.forEach(function(key){
    var m = MODES[key];

    /* gate card (button) — title + body + go carry data-es for the swap */
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'gate-choice';
    card.setAttribute('data-choose', m.id);
    card.innerHTML =
      '<span class="gc-ico" aria-hidden="true">' + m.gateIcon + '</span>' +
      '<span class="gc-title" data-es="' + esc(m.gateTitle_es) + '">' + esc(m.gateTitle) + '</span>' +
      '<span class="gc-body" data-es="' + esc(m.gateBody_es) + '">' + esc(m.gateBody) + '</span>' +
      '<span class="gc-go" aria-hidden="true" data-es="' + esc(m.gateGo_es + ' →') + '">' + esc(m.gateGo) + ' →</span>';
    choicesEl.appendChild(card);

    /* header radio + label — label text carries data-es for the swap */
    var input = document.createElement('input');
    input.type = 'radio';
    input.name = 'bb-mode-toggle';
    input.id = 'mt-' + m.id;
    input.value = m.id;
    var label = document.createElement('label');
    label.className = 'lbl';
    label.setAttribute('for', 'mt-' + m.id);
    label.innerHTML = '<span class="ic" aria-hidden="true">' + m.toggleIcon + '</span> '
      + '<span class="lbl-txt" data-es="' + esc(m.label_es) + '">' + esc(m.label) + '</span>';
    toggleEl.appendChild(input);
    toggleEl.appendChild(label);

    card.addEventListener('click', function(){ chooseMode(m.id, true); closeGate(); });
    input.addEventListener('change', function(){ if (input.checked) setMode(m.id, { fade:true, save:true }); });
  });

  /* ============================================================
     LANGUAGE — client-side EN/ES copy swap.

     Mechanism: every translatable element carries data-es holding its
     Spanish INNER HTML (inline child tags preserved). On the FIRST apply
     we capture the element's original English innerHTML into data-en, so
     toggling is a lossless innerHTML swap between the two stored values.
     Attributes (placeholder / aria-label / alt) use parallel
     data-es-placeholder / data-es-aria-label / data-es-alt, captured into
     data-en-* on first apply and swapped as attributes (never content).
     ============================================================ */
  function swapContent(el, lang){
    if (el.getAttribute('data-en') === null){
      el.setAttribute('data-en', el.innerHTML);   /* capture English once */
    }
    var html = el.getAttribute('data-' + lang);
    if (html !== null) el.innerHTML = html;
  }
  function swapAttr(el, attr, lang){
    var enKey = 'data-en-' + attr, esKey = 'data-es-' + attr;
    if (el.getAttribute(enKey) === null){
      el.setAttribute(enKey, el.getAttribute(attr) || '');
    }
    var v = (lang === 'es') ? el.getAttribute(esKey) : el.getAttribute(enKey);
    if (v !== null) el.setAttribute(attr, v);
  }

  function applyLang(lang){
    if (lang !== 'es' && lang !== 'en') lang = DEFAULT_LANG;
    LANG = lang;

    /* content swaps */
    var nodes = document.querySelectorAll('[data-es]');
    for (var i = 0; i < nodes.length; i++){ swapContent(nodes[i], lang); }

    /* attribute swaps */
    var ph = document.querySelectorAll('[data-es-placeholder]');
    for (var p = 0; p < ph.length; p++){ swapAttr(ph[p], 'placeholder', lang); }
    var ar = document.querySelectorAll('[data-es-aria-label]');
    for (var a = 0; a < ar.length; a++){ swapAttr(ar[a], 'aria-label', lang); }
    var al = document.querySelectorAll('[data-es-alt]');
    for (var t = 0; t < al.length; t++){ swapAttr(al[t], 'alt', lang); }

    /* the footer-year span lives inside a swapped container — restore it */
    setYear();

    /* <html lang> + a state class for any lang-specific CSS hooks */
    docEl.lang = lang;
    docEl.classList.remove('lang-en', 'lang-es');
    docEl.classList.add('lang-' + lang);

    /* reflect state on the footer toggle buttons */
    if (langBtns){
      langBtns.forEach(function(b){
        b.setAttribute('aria-pressed', b.getAttribute('data-lang') === lang ? 'true' : 'false');
      });
    }

    /* the hamburger aria-label depends on BOTH open-state and language */
    syncHamburgerLabel();
  }

  /* localized hamburger label (open vs close, EN vs ES) */
  function syncHamburgerLabel(){
    var hb = document.getElementById('hamburger');
    if (!hb) return;
    var open = hb.getAttribute('aria-expanded') === 'true';
    var map = {
      en: { open: 'Close menu', closed: 'Open menu' },
      es: { open: 'Cerrar menú', closed: 'Abrir menú' }
    };
    hb.setAttribute('aria-label', map[LANG][open ? 'open' : 'closed']);
  }

  /* footer language toggle */
  var langToggleEl = document.querySelector('.lang-toggle');
  var langBtns = langToggleEl ? Array.prototype.slice.call(langToggleEl.querySelectorAll('.lang-btn')) : [];
  function chooseLang(lang){
    if (lang === LANG) return;
    applyLang(lang);
    saveLang(lang);
    try{ navigator.sendBeacon('/api/event', new Blob([JSON.stringify({name:'lang_'+lang})],{type:'application/json'})); }catch(_){ }
  }
  langBtns.forEach(function(b){
    b.addEventListener('click', function(){ chooseLang(b.getAttribute('data-lang')); });
  });

  /* ============================================================
     APPLY a mode: set attribute, sync toggle, cross-fade
     ============================================================ */
  function setMode(mode, opts){
    opts = opts || {};
    if (!MODES[mode]) mode = DEFAULT_MODE;
    docEl.setAttribute('data-mode', mode);

    /* sync the segmented radio */
    var radio = document.getElementById('mt-' + mode);
    if (radio) radio.checked = true;

    /* cross-fade the content (reduced-motion safe — CSS no-ops the anim) */
    if (opts.fade && !reduceMQ.matches){
      mainEl.classList.remove('mode-fade');
      void mainEl.offsetWidth; /* reflow to restart animation */
      mainEl.classList.add('mode-fade');
    }

    if (opts.save) saveMode(mode);
    revealVisible();
  }

  /* chooseMode = user explicitly picked (always persists) */
  function chooseMode(mode){ setMode(mode, { fade:true, save:true }); try{ navigator.sendBeacon('/api/event', new Blob([JSON.stringify({name:'mode_'+mode})],{type:'application/json'})); }catch(_){ } }

  /* ============================================================
     INTRO GATE — focus trap, Esc to skip, ARIA
     ============================================================ */
  var gate = document.getElementById('gate');
  var skipBtn = document.getElementById('gate-skip');
  var lastFocus = null;

  function focusable(){
    return Array.prototype.slice.call(
      gate.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function(el){ return el.offsetParent !== null; });
  }

  function openGate(){
    lastFocus = document.activeElement;
    gate.hidden = false;
    gate.classList.add('open');
    document.body.style.overflow = 'hidden';
    var f = focusable();
    if (f.length) f[0].focus();
    document.addEventListener('keydown', onGateKey, true);
  }

  function closeGate(){
    gate.classList.remove('open');
    gate.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onGateKey, true);
    /* return focus to the toggle so keyboard users keep their place */
    var t = document.getElementById('mt-' + (docEl.getAttribute('data-mode') || DEFAULT_MODE));
    if (t) t.focus(); else if (lastFocus) lastFocus.focus();
  }

  function onGateKey(e){
    if (e.key === 'Escape'){
      e.preventDefault();
      /* Esc acts as skip → default mode, persisted */
      chooseMode(DEFAULT_MODE);
      closeGate();
      return;
    }
    if (e.key === 'Tab'){
      var f = focusable();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first){
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last){
        e.preventDefault(); first.focus();
      }
    }
  }

  skipBtn.addEventListener('click', function(){ chooseMode(DEFAULT_MODE); closeGate(); });

  /* "Not you? Choose again" — re-opens the gate. Delegated, because the
     button lives inside a [data-es] container whose innerHTML is swapped on
     language change, which would otherwise drop a directly-bound listener. */
  document.addEventListener('click', function(e){
    if (e.target.closest('#reopen-gate')) openGate();
  });

  /* ============================================================
     APPLY LANGUAGE — synchronous, at body end (DOM already parsed and
     the JS-built gate cards / toggle labels already inserted above). A
     returning ES visitor sees Spanish with no flash; the inline <head>
     script already set <html lang> early so the lang attr never flickers.
     ============================================================ */
  applyLang(LANG);

  /* ============================================================
     BOOT: returning visitors skip the gate; first-timers see it.
     ============================================================ */
  var saved = readMode();
  if (saved && MODES[saved]){
    setMode(saved, { save:false });          /* land straight in their mode */
  } else {
    setMode(DEFAULT_MODE, { save:false });    /* default content underneath */
    openGate();                               /* first visit → show gate */
  }

  /* ============================================================
     LOAD REVEAL — staggered, reduced-motion aware. Re-run on mode
     switch so the newly shown panel animates in. Includes the shared
     #contact section's [data-reveal] (it lives outside the panels).
     ============================================================ */
  function revealVisible(){
    var items = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'))
      .filter(function(el){ return el.offsetParent !== null; });
    if (reduceMQ.matches || !('IntersectionObserver' in window)){
      items.forEach(function(el){ el.classList.add('in'); });
      return;
    }
    items.forEach(function(el){ el.classList.remove('in'); });
    var io = new IntersectionObserver(function(entries){
      var delay = 0;
      entries.forEach(function(entry){
        if (entry.isIntersecting){
          var el = entry.target;
          setTimeout(function(){ el.classList.add('in'); }, delay);
          delay += 80;
          io.unobserve(el);
        }
      });
    }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
    items.forEach(function(el){ io.observe(el); });
  }

  /* ============================================================
     SMOOTH ANCHORS (reduced-motion safe)
     ============================================================ */
  document.addEventListener('click', function(e){
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href');
    if (id.length <= 1) return;
    var target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: reduceMQ.matches ? 'auto' : 'smooth', block: 'start' });
    target.setAttribute('tabindex','-1');
    target.focus({ preventScroll: true });
  });

  /* ============================================================
     CONTACT FORM — REAL submit. POSTs JSON to the /api/contact
     Cloudflare Worker. Mechanism copied from the proven coming-soon
     page: Turnstile token + hidden `botcheck` honeypot. The payload
     is built from FormData, so the UNCHECKED honeypot is naturally
     omitted (the worker treats ANY presence of `botcheck` as a bot).
     ============================================================ */
  /* localized strings the JS sets at runtime (status messages + button) */
  var T = {
    en: {
      invalid: 'Please add your name, a valid email, and a short note.',
      verify:  'Please complete the verification above the button, then send.',
      sending: 'Sending…',
      ok:      'Got it — I’ll be in touch within a business day. 🍌',
      fail:    'Something went wrong sending that. Try again, or just email contact@bananabyte.io.',
      submit:  'Send it over'
    },
    es: {
      invalid: 'Añade tu nombre, un correo válido y una nota breve, por favor.',
      verify:  'Completa la verificación de arriba del botón y luego envía, por favor.',
      sending: 'Enviando…',
      ok:      'Recibido — te escribo dentro de un día hábil. 🍌',
      fail:    'Algo salió mal al enviar. Inténtalo de nuevo o escribe a contact@bananabyte.io.',
      submit:  'Enviar'
    }
  };
  function t(key){ return (T[LANG] || T.en)[key]; }

  var form = document.getElementById('contact-form');
  if (form){
    var st = document.getElementById('contact-status');
    var btn = document.getElementById('contact-submit');
    var lbl = form.querySelector('.cf-lbl');
    function setStatus(kind, msg){ st.className = 'form-status' + (kind ? ' ' + kind : ''); st.textContent = msg || ''; }

    form.addEventListener('submit', function(e){
      e.preventDefault();

      /* native required-field validation first */
      if (!form.checkValidity()){
        setStatus('err', t('invalid'));
        var bad = form.querySelector(':invalid');
        if (bad && bad.focus) bad.focus();
        return;
      }
      /* honeypot tripped client-side → bail silently (server also 200s) */
      if (form.botcheck && form.botcheck.checked) return;

      /* Turnstile token must be present before sending */
      var ts = form.querySelector('[name="cf-turnstile-response"]');
      if (ts && !ts.value){
        setStatus('err', t('verify'));
        var w = form.querySelector('.cf-turnstile');
        if (w && w.scrollIntoView) w.scrollIntoView({ block:'center' });
        return;
      }

      setStatus('busy', t('sending'));
      btn.disabled = true;
      if (lbl) lbl.textContent = t('sending');
      try{ navigator.sendBeacon('/api/event', new Blob([JSON.stringify({name:'form_submit'})],{type:'application/json'})); }catch(_){ }

      /* build JSON payload from FormData — unchecked honeypot is omitted */
      var data = {};
      new FormData(form).forEach(function(v, k){ data[k] = v; });

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function(r){ return r.json().then(function(j){ return { ok:r.ok, j:j }; }); })
        .then(function(r){
          if (r.ok && r.j && r.j.success){
            setStatus('ok', t('ok'));
            form.reset();
            /* reset Turnstile so a second message can be sent */
            if (window.turnstile){ try{ window.turnstile.reset(); }catch(_){} }
          } else {
            setStatus('err', t('fail'));
            if (window.turnstile){ try{ window.turnstile.reset(); }catch(_){} }
          }
        })
        .catch(function(){
          setStatus('err', t('fail'));
          if (window.turnstile){ try{ window.turnstile.reset(); }catch(_){} }
        })
        .finally(function(){
          btn.disabled = false;
          if (lbl) lbl.textContent = t('submit');
        });
    });
  }

  /* ============================================================
     MOBILE MENU — slide-in drawer + #mode-toggle RELOCATION.
     The ONE #mode-toggle node lives in .nav-left on desktop and is
     moved into #menu-toggle-slot on mobile. We MOVE the existing node
     (never clone it), so chooseMode/setMode and the analytics beacon
     keep working in both locations with a single radio group.
     ============================================================ */
  var mq          = window.matchMedia('(max-width: 979px)');
  var navLeft     = document.querySelector('.nav-left');
  var modeToggle  = document.getElementById('mode-toggle');
  var menuSlot    = document.getElementById('menu-toggle-slot');
  var hamburger   = document.getElementById('hamburger');
  var menu        = document.getElementById('mobile-menu');
  var backdrop    = document.getElementById('nav-backdrop');
  var langToggle  = document.querySelector('.lang-toggle');
  var langSlot    = document.getElementById('menu-lang-slot');
  var langHome    = langToggle ? langToggle.parentNode : null;        /* footer .foot-bottom */
  var langNext    = langToggle ? langToggle.nextElementSibling : null; /* the "Not you?" span */
  var lastMenuFocus = null;

  /* placeMode — put the toggle where the current breakpoint needs it */
  function placeMode(){
    if (mq.matches){
      /* mobile: move both toggles into the drawer */
      if (modeToggle && modeToggle.parentNode !== menuSlot) menuSlot.appendChild(modeToggle);
      if (langToggle && langSlot && langToggle.parentNode !== langSlot) langSlot.appendChild(langToggle);
    } else {
      /* desktop: mode toggle back into .nav-left, lang toggle back into the footer */
      if (modeToggle && modeToggle.parentNode !== navLeft) navLeft.appendChild(modeToggle);
      if (langToggle && langHome && langToggle.parentNode !== langHome) langHome.insertBefore(langToggle, langNext);
    }
  }

  function menuFocusable(){
    return Array.prototype.slice.call(
      menu.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function(el){ return el.offsetParent !== null; });
  }

  function openMenu(){
    if (!menu) return;
    lastMenuFocus = document.activeElement;
    menu.hidden = false; backdrop.hidden = false;
    /* allow the unhidden elements to lay out before animating in */
    void menu.offsetWidth;
    menu.classList.add('open'); backdrop.classList.add('open');
    menu.setAttribute('aria-hidden', 'false');
    hamburger.setAttribute('aria-expanded', 'true');
    syncHamburgerLabel();
    docEl.classList.add('menu-open');
    var f = menuFocusable();
    if (f.length) f[0].focus();
    document.addEventListener('keydown', onMenuKey, true);
  }

  function closeMenu(returnFocus){
    if (!menu) return;
    menu.classList.remove('open'); backdrop.classList.remove('open');
    menu.setAttribute('aria-hidden', 'true');
    hamburger.setAttribute('aria-expanded', 'false');
    syncHamburgerLabel();
    docEl.classList.remove('menu-open');
    document.removeEventListener('keydown', onMenuKey, true);
    var done = function(){ menu.hidden = true; backdrop.hidden = true; menu.removeEventListener('transitionend', done); };
    if (reduceMQ.matches){ done(); } else { menu.addEventListener('transitionend', done); setTimeout(done, 400); }
    if (returnFocus !== false && hamburger) hamburger.focus();
  }

  function onMenuKey(e){
    if (e.key === 'Escape'){ e.preventDefault(); closeMenu(); return; }
    if (e.key === 'Tab'){
      var f = menuFocusable();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
  }

  if (hamburger && menu && backdrop){
    hamburger.addEventListener('click', function(){
      if (menu.classList.contains('open')) closeMenu(); else openMenu();
    });
    backdrop.addEventListener('click', function(){ closeMenu(); });
    /* close when a list link OR the CTA is tapped (let the anchor navigate) */
    menu.addEventListener('click', function(e){
      if (e.target.closest('a[href]')) closeMenu(false);
    });
  }

  /* relocate the toggle now (DOM is parsed: this script runs at body end)
     and whenever we cross the 979px breakpoint. Also tidy the menu if we
     resize up to desktop while it's open. */
  placeMode();
  mq.addEventListener('change', function(){
    placeMode();
    if (!mq.matches && menu && menu.classList.contains('open')) closeMenu(false);
  });

})();
