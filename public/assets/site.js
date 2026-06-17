(function(){
  "use strict";

  /* ============================================================
     BANANAbyte — unified shell behavior.
     One brand, no audience modes. This script wires:
       • EN/ES language toggle (+ relocation into the mobile drawer)
       • the hamburger slide-in drawer (open/close/focus-trap/scroll-lock)
       • the ambient moss-spore field
       • the [data-reveal] scroll-reveal IntersectionObserver
       • the contact-form submit (Turnstile + honeypot → /api/contact)
       • analytics beacons + footer year
     ============================================================ */
  var LANG_KEY = 'bb-lang';
  var DEFAULT_LANG = 'en';

  var docEl = document.documentElement;
  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- safe storage helpers ---------- */
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
     APPLY LANGUAGE — synchronous, at body end (DOM already parsed).
     A returning ES visitor sees Spanish with no flash; the inline
     <head> script already set <html lang> early so the lang attr never
     flickers.
     ============================================================ */
  applyLang(LANG);

  /* ============================================================
     LOAD REVEAL — staggered, reduced-motion aware. Reveals every
     [data-reveal] element as it enters the viewport.
     ============================================================ */
  function revealVisible(){
    var items = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
    if (reduceMQ.matches){ items.forEach(function(el){ el.classList.add('in'); }); return; }
    function show(el, d){ if (el.classList.contains('in')) return; if (d) setTimeout(function(){ el.classList.add('in'); }, d); else el.classList.add('in'); }

    /* On load: reveal everything already in/above the viewport INSTANTLY (no
       blank flash), with only a tiny CAPPED cascade for the just-below items. */
    var vh = window.innerHeight, near = [];
    items.forEach(function(el){
      var t = el.getBoundingClientRect().top;
      if (t < vh * 0.96) show(el, 0);
      else if (t < vh * 1.4) near.push(el);
    });
    near.forEach(function(el, i){ show(el, Math.min(i, 4) * 55); });   /* max ~220ms, never a long queue */

    if (!('IntersectionObserver' in window)){ items.forEach(function(el){ show(el, 0); }); return; }

    /* Observe the rest; reveal the moment they edge into view (no stagger queue). */
    var io = new IntersectionObserver(function(entries, obs){
      entries.forEach(function(e){ if (e.isIntersecting){ show(e.target, 0); obs.unobserve(e.target); } });
    }, { threshold: 0, rootMargin: '0px 0px 8% 0px' });
    items.forEach(function(el){ if (!el.classList.contains('in')) io.observe(el); });

    /* BACKSTOP: fast scrolling can outrun the observer — on every scroll frame,
       immediately reveal anything now in view so a section is NEVER stuck blank. */
    var ticking = false;
    function allShown(){ for (var i = 0; i < items.length; i++) if (!items[i].classList.contains('in')) return false; return true; }
    function sweep(){
      ticking = false; var h = window.innerHeight;
      /* if we've hit the bottom of the page, reveal everything left — there's
         nowhere further to scroll, so nothing may stay hidden. */
      var atBottom = (window.pageYOffset + h) >= (document.documentElement.scrollHeight - 4);
      /* READ phase, then WRITE phase. Reading getBoundingClientRect AFTER a
         classList write forces a synchronous reflow, so interleaving them over
         78 nodes thrashed layout on fast scroll. Batch all reads, then writes. */
      var toShow = [];
      for (var i = 0; i < items.length; i++){
        var el = items[i];
        if (el.classList.contains('in')) continue;
        if (atBottom || el.getBoundingClientRect().top < h) toShow.push(el);
      }
      for (var j = 0; j < toShow.length; j++) toShow[j].classList.add('in');
      if (allShown()){ window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); }
    }
    /* The IntersectionObserver above already reveals nodes as they enter view.
       We only need a CHEAP resting-position backstop for the rare case a fast
       flick outruns the observer: a debounced sweep AFTER scrolling settles,
       never a layout read on every scroll frame, and never while hidden. */
    var trail = null;
    function onScroll(){
      if (document.hidden) return;
      clearTimeout(trail);
      trail = setTimeout(function(){ requestAnimationFrame(sweep); }, 150);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }
  revealVisible();

  /* ============================================================
     "BLUEPRINT → BUILT" — once the hero/ticker scrolls past the top,
     the studio gets down to business: the site itself reassembles IN
     PLACE — the words rebuild block-by-block, edges square off, and
     the palette cools to graphite + a blueprint grid (html.is-serious).
     No screen-covering curtain; the real content does the work, fast.
     Reverses on scroll up. Home only (#serious-sentinel marker).
     ============================================================ */
  (function seriousMode(){
    var sentinel = document.getElementById('serious-sentinel');
    if (!sentinel) return;                       /* home page only */
    var root = document.documentElement;
    var reduce = window.matchMedia('(prefers-reduced-motion:reduce)');

    /* faint blueprint grid that fades in when serious — injected, not in HTML */
    var grid = document.createElement('div');
    grid.className = 'bp-grid'; grid.setAttribute('aria-hidden', 'true');
    document.body.appendChild(grid);

    var serious = false, busy = false, timer = null;

    /* Fully CSS-driven + fast: the `theme-switching` class arms the block-build
       animations on the REAL headings/words/cards; `is-serious` swaps the
       palette + grid + square edges. We just flip two classes. */
    function apply(toSerious){
      busy = true;
      root.classList.add('theme-switching');
      root.classList.toggle('is-serious', toSerious);
      clearTimeout(timer);
      timer = setTimeout(function(){
        root.classList.remove('theme-switching');
        busy = false;
        sync();           /* re-check in case the user scrolled mid-transition */
      }, 560);
    }

    function pastHero(){ return sentinel.getBoundingClientRect().top <= 0; }

    function sync(){
      if (busy) return;
      var want = pastHero();
      if (want === serious) return;
      serious = want;
      if (reduce.matches || document.hidden){ root.classList.toggle('is-serious', serious); }
      else apply(serious);
    }

    /* A rAF-throttled scroll check — robust to fast flings/anchor jumps that an
       IntersectionObserver MISSES (the sentinel can leap from below the fold to
       above the viewport in one frame, never "intersecting"). One
       getBoundingClientRect + a boolean compare per frame; real work only on flip. */
    var ticking = false;
    function onScroll(){ if (document.hidden) return; if (!ticking){ ticking = true; requestAnimationFrame(function(){ ticking = false; sync(); }); } }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    /* initial state with NO animation (e.g. refresh already scrolled down) */
    serious = pastHero();
    root.classList.toggle('is-serious', serious);
  })();

  /* ============================================================
     MOSS FLASH — ambient bioluminescent spore field (the identity
     atmosphere for every page). Lightweight: ~16 absolutely-positioned
     blurred green dots whose drift + pulse are pure CSS animations
     (transform/opacity only, so they composite on the GPU and never
     thrash layout). The JS just creates the nodes once and sets per-node
     CSS vars for variety.

     Guards:
       • never builds when prefers-reduced-motion is set
       • pauses (animation-play-state) when the tab is hidden
       • container is position:fixed + overflow:hidden + contain:strict,
         pointer-events:none → cannot create scrollbars or block clicks
     ============================================================ */
  var sporeLayer = document.querySelector('.moss-spores');

  function rand(min, max){ return min + Math.random() * (max - min); }

  function buildSpores(){
    /* guard on the JS handle AND the DOM, so we can never double-inject */
    if (sporeLayer || document.querySelector('.moss-spores') || reduceMQ.matches) return;
    var SPORE_COUNT = 16;
    var layer = document.createElement('div');
    layer.className = 'moss-spores';
    layer.setAttribute('aria-hidden', 'true');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < SPORE_COUNT; i++){
      var s = document.createElement('span');
      s.className = 'moss-spore';
      var size = rand(4, 11);                 /* px — small, soft dots */
      s.style.width  = size.toFixed(1) + 'px';
      s.style.height = size.toFixed(1) + 'px';
      s.style.left   = rand(2, 96).toFixed(2) + 'vw';
      /* CSS custom props the keyframes read for per-node variety */
      s.style.setProperty('--drift', rand(22, 40).toFixed(1) + 's');
      s.style.setProperty('--pulse', rand(4, 7).toFixed(1) + 's');
      s.style.setProperty('--delay', (-rand(0, 26)).toFixed(1) + 's'); /* negative = start mid-cycle, no pop-in */
      s.style.setProperty('--sway',  (rand(-22, 22)).toFixed(0) + 'px');
      s.style.setProperty('--o-min', rand(0.12, 0.22).toFixed(2));
      s.style.setProperty('--o-max', rand(0.5, 0.72).toFixed(2));
      frag.appendChild(s);
    }
    layer.appendChild(frag);
    document.body.appendChild(layer);
    sporeLayer = layer;
    /* honor current tab visibility immediately */
    if (document.hidden) layer.classList.add('paused');
  }

  function destroySpores(){
    if (sporeLayer && sporeLayer.parentNode){ sporeLayer.parentNode.removeChild(sporeLayer); }
    sporeLayer = null;
  }

  /* build the field unless reduced-motion asks us not to */
  function syncSpores(){
    if (!reduceMQ.matches){ buildSpores(); }
    else { destroySpores(); }
  }

  /* pause the drift when the tab is backgrounded (battery + frames) */
  document.addEventListener('visibilitychange', function(){
    if (!sporeLayer) return;
    sporeLayer.classList.toggle('paused', document.hidden);
  });

  /* react if the user flips reduced-motion at runtime */
  if (reduceMQ.addEventListener){
    reduceMQ.addEventListener('change', syncSpores);
  } else if (reduceMQ.addListener){
    reduceMQ.addListener(syncSpores);     /* older Safari */
  }

  /* ---- HERO ENTRANCE — orchestrated stagger on first paint.
     We add .hero-enter to every VISIBLE .hero so the CSS keyframes fire.
     Skipped under reduced-motion (CSS also no-ops it as a belt-and-braces). */
  function playHeroEnter(){
    if (reduceMQ.matches) return;
    var heroes = document.querySelectorAll('.hero');
    for (var i = 0; i < heroes.length; i++){
      var h = heroes[i];
      if (h.offsetParent === null) continue;
      h.classList.remove('hero-enter');
      void h.offsetWidth;                               /* reflow to restart the run */
      h.classList.add('hero-enter');
    }
  }

  /* kick the moss flash + hero entrance */
  syncSpores();
  playHeroEnter();

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
     Cloudflare Worker. Turnstile token + hidden `botcheck` honeypot.
     The payload is built from FormData, so the UNCHECKED honeypot is
     naturally omitted (the worker treats ANY presence of `botcheck`
     as a bot).
     ============================================================ */
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
     MOBILE MENU — slide-in drawer + lang-toggle RELOCATION.
     The footer .lang-toggle node is MOVED into #menu-lang-slot on mobile
     and back into the footer on desktop (we MOVE the node, never clone it,
     so its listeners + state stay intact in both locations).
     ============================================================ */
  var mq          = window.matchMedia('(max-width: 979px)');
  var hamburger   = document.getElementById('hamburger');
  var menu        = document.getElementById('mobile-menu');
  var backdrop    = document.getElementById('nav-backdrop');
  var langToggle  = document.querySelector('.lang-toggle');
  var langSlot    = document.getElementById('menu-lang-slot');
  var langHome    = langToggle ? langToggle.parentNode : null;        /* footer .foot-bottom */
  var langNext    = langToggle ? langToggle.nextElementSibling : null; /* whatever follows it */
  var lastMenuFocus = null;

  /* placeToggles — put the lang toggle where the current breakpoint needs it */
  function placeToggles(){
    if (mq.matches){
      /* mobile: move the lang toggle into the drawer */
      if (langToggle && langSlot && langToggle.parentNode !== langSlot) langSlot.appendChild(langToggle);
    } else {
      /* desktop: lang toggle back into the footer, in its original slot */
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
    /* the in-drawer close (X) button mirrors the hamburger: close + return focus */
    menu.addEventListener('click', function(e){
      if (e.target.closest('[data-mm-close]')){ closeMenu(); return; }
      /* close when a list link OR the CTA is tapped (let the anchor navigate) */
      if (e.target.closest('a[href]')) closeMenu(false);
    });
  }

  /* relocate the lang toggle now (DOM is parsed: this script runs at body end)
     and whenever we cross the 979px breakpoint. Also tidy the menu if we
     resize up to desktop while it's open. */
  placeToggles();
  mq.addEventListener('change', function(){
    placeToggles();
    if (!mq.matches && menu && menu.classList.contains('open')) closeMenu(false);
  });

  /* ============================================================
     SERVICES DROPDOWN (desktop ≥980px). The CSS already shows the panel
     on :hover and :focus-within (no JS needed for the visual), so the
     panel is keyboard-reachable by Tab without a focus trap. This JS only:
       • keeps aria-expanded truthful (hover + focus open it; Esc/blur/
         outside-click close it) so assistive tech is in sync
       • closes on Esc and returns focus to the trigger
       • closes on outside click
     The trigger stays a real link to /services/, so a plain click still
     navigates there — the dropdown is the hover/expand affordance.
     ============================================================ */
  var navDD        = document.querySelector('[data-nav-dd]');
  var navDDTrigger = navDD ? navDD.querySelector('[data-nav-dd-trigger]') : null;
  if (navDD && navDDTrigger){
    var ddHoverOpen = false;   /* pointer is over the dropdown */
    var ddFocusOpen = false;   /* focus is somewhere inside the dropdown */
    var ddEscaped   = false;   /* Esc just fired — suppress the refocus re-open */

    function ddSyncAria(){
      navDDTrigger.setAttribute('aria-expanded', (ddHoverOpen || ddFocusOpen) ? 'true' : 'false');
      navDD.classList.toggle('open', ddFocusOpen);   /* .open = keyboard/click state */
    }

    /* hover: CSS does the showing; we just track it for aria + don't trap */
    navDD.addEventListener('mouseenter', function(){ ddHoverOpen = true; ddSyncAria(); });
    navDD.addEventListener('mouseleave', function(){ ddHoverOpen = false; ddSyncAria(); });

    /* focus moving into / out of the dropdown subtree. After an Esc we return
       focus to the trigger (which lives INSIDE navDD), so that refocus fires a
       focusin — ignore exactly that one so the panel stays closed. */
    navDD.addEventListener('focusin',  function(){
      if (ddEscaped){ ddEscaped = false; return; }
      ddFocusOpen = true; ddSyncAria();
    });
    navDD.addEventListener('focusout', function(e){
      if (!navDD.contains(e.relatedTarget)){ ddFocusOpen = false; ddSyncAria(); }
    });

    /* click on the trigger also opens the panel (in addition to the link
       navigating) — toggles the persistent .open state for touch/click users.
       We do NOT preventDefault: the label still navigates to /services/. */
    navDDTrigger.addEventListener('click', function(){
      ddEscaped = false;
      ddFocusOpen = true; ddSyncAria();
    });

    /* Esc closes the panel and returns focus to the trigger */
    navDD.addEventListener('keydown', function(e){
      if (e.key === 'Escape' || e.key === 'Esc'){
        ddEscaped = true;                /* swallow the refocus-triggered focusin */
        ddFocusOpen = false; ddHoverOpen = false; ddSyncAria();
        navDDTrigger.focus();
      }
    });

    /* outside-click closes the persistent (click/focus) open state */
    document.addEventListener('click', function(e){
      if (!navDD.contains(e.target)){ ddFocusOpen = false; ddSyncAria(); }
    });
  }

  /* ============================================================
     SERVICES ACCORDION (mobile ≤979px, inside the drawer). The toggle
     button expands an inline list of the same services. Toggling flips its
     own aria-expanded and the panel's [hidden]. The drawer's link-close
     handler only fires for real anchors, so tapping THIS button never
     closes the drawer; tapping a service link inside it does.
     ============================================================ */
  var mmAccToggle = document.querySelector('[data-mm-acc-toggle]');
  if (mmAccToggle){
    var mmAccPanel = document.getElementById(mmAccToggle.getAttribute('aria-controls'));
    mmAccToggle.addEventListener('click', function(){
      var open = mmAccToggle.getAttribute('aria-expanded') === 'true';
      mmAccToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      if (mmAccPanel) mmAccPanel.hidden = open;
    });
  }

  /* ============================================================
     MISSION-CONTROL LAYER — the "alive console" behaviors.
       1. LIVE CLOCK   — ticks every second (America/New_York), paused
                         when the tab is hidden.
       2. ANIMATED COUNTERS — count up when they scroll into view.
       3. MOUSE-REACTIVE AMBIENT (desktop) — a faint moss glow tracks the
                         cursor; the hero panel + banana parallax to it.
       4. PARALLAX SCROLL (desktop) — hero art drifts slightly on scroll.
     All rAF-throttled (no layout thrash), all gated by reduced-motion and
     paused on tab-hidden. Mouse/scroll effects are desktop + fine-pointer
     only so phones stay light.
     ============================================================ */
  var desktopMQ = window.matchMedia('(min-width: 980px)');
  var finePtrMQ = window.matchMedia('(hover: hover) and (pointer: fine)');

  /* ---- 1. LIVE CLOCK ---------------------------------------------------- */
  (function liveClock(){
    var els = document.querySelectorAll('[data-clock]');
    if (!els.length) return;

    /* Build the "HH:MM:SS AM" string in America/New_York without pulling a
       library: Intl gives us the parts; we keep our own markup so the EN/ES
       label that already lives in the DOM is preserved. */
    var fmt, tzfmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
      });
      tzfmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' });
    } catch(e){ fmt = null; }

    /* Eastern timezone abbreviation (EDT in summer, EST in winter) — this is
       Gabe's time, shown so visitors anywhere know his hours. */
    function easternAbbr(){
      if (tzfmt){
        try { var ps = tzfmt.formatToParts(new Date());
          for (var i = 0; i < ps.length; i++) if (ps[i].type === 'timeZoneName') return ps[i].value;
        } catch(e){}
      }
      var mo = new Date().getMonth(); return (mo > 2 && mo < 10) ? 'EDT' : 'EST';   /* rough DST guess */
    }

    function paint(){
      var time = '', mer = '', abbr = easternAbbr();
      if (fmt){
        try {
          var parts = fmt.formatToParts(new Date());
          var h = '', m = '', s = '';
          for (var i = 0; i < parts.length; i++){
            var p = parts[i];
            if (p.type === 'hour') h = p.value;
            else if (p.type === 'minute') m = p.value;
            else if (p.type === 'second') s = p.value;
            else if (p.type === 'dayPeriod') mer = p.value.toUpperCase();
          }
          time = h + ':' + m + ':' + s;
        } catch(e2){ fmt = null; }
      }
      if (!fmt){
        /* fallback: derive EASTERN from UTC (+DST guess) so it's still Gabe's
           time, never the visitor's local time. */
        var off = (abbr === 'EDT') ? -4 : -5;
        var d = new Date(), e = new Date(d.getTime() + (d.getTimezoneOffset() + off * 60) * 60000);
        var hh = e.getHours(), mm = e.getMinutes(), ss = e.getSeconds();
        mer = hh >= 12 ? 'PM' : 'AM';
        var h12 = hh % 12; if (h12 === 0) h12 = 12;
        time = (h12 < 10 ? '0' + h12 : h12) + ':' + (mm < 10 ? '0' + mm : mm) + ':' + (ss < 10 ? '0' + ss : ss);
      }
      for (var k = 0; k < els.length; k++){
        els[k].innerHTML = time + ' <span class="hs-mer">' + mer + '</span> <span class="hs-tzlabel">' + abbr + '</span>';
      }
    }

    var clockTimer = null;
    function start(){ if (clockTimer) return; paint(); clockTimer = setInterval(paint, 1000); }
    function stop(){ if (clockTimer){ clearInterval(clockTimer); clockTimer = null; } }

    paint();                                  /* first paint immediately */
    if (!document.hidden) start();
    /* pause ticking when the tab is hidden (battery + no wasted frames) */
    document.addEventListener('visibilitychange', function(){
      if (document.hidden) stop(); else start();
    });
  })();

  /* ---- 2. ANIMATED COUNTERS --------------------------------------------- */
  (function counters(){
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.count[data-count]'));
    if (!nodes.length) return;

    /* reduced-motion / no-IO: just show the final values, no animation */
    if (reduceMQ.matches || !('IntersectionObserver' in window)){
      nodes.forEach(function(el){
        var target = parseInt(el.getAttribute('data-count'), 10) || 0;
        el.textContent = target + (el.getAttribute('data-count-suffix') || '');
      });
      return;
    }

    function run(el){
      if (el.getAttribute('data-counted') === '1') return;
      el.setAttribute('data-counted', '1');
      var target = parseInt(el.getAttribute('data-count'), 10) || 0;
      var suffix = el.getAttribute('data-count-suffix') || '';
      var dur = 1100, start = null;
      el.classList.add('counting');
      function step(ts){
        if (start === null) start = ts;
        var t = Math.min(1, (ts - start) / dur);
        /* easeOutCubic — fast then settle */
        var eased = 1 - Math.pow(1 - t, 3);
        var val = Math.round(eased * target);
        el.textContent = val + suffix;
        if (t < 1){ requestAnimationFrame(step); }
        else { el.textContent = target + suffix; el.classList.remove('counting'); }
      }
      /* start from 0 so the count is visible */
      el.textContent = '0' + suffix;
      requestAnimationFrame(step);
    }

    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (entry.isIntersecting){ run(entry.target); io.unobserve(entry.target); }
      });
    }, { threshold: 0.6 });
    nodes.forEach(function(el){ io.observe(el); });
  })();

  /* ---- 3 + 4. MOUSE-REACTIVE AMBIENT + PARALLAX (desktop, fine pointer) -- */
  (function pointerAndScroll(){
    if (reduceMQ.matches) return;

    var parallaxEls = Array.prototype.slice.call(document.querySelectorAll('[data-parallax]'));
    var scrollEls   = Array.prototype.slice.call(document.querySelectorAll('[data-scroll]'));
    /* nothing to parallax AND no hero art to light -> don't bind pointer/scroll
       work or inject the ambient-glow layer on pages that lack the home hero.
       [data-parallax]/[data-scroll] live ONLY on the home page; on every inner
       page this avoids a fixed full-viewport .ambient-glow (radial-gradient)
       that would repaint on every pointermove for no benefit. */
    if (!parallaxEls.length && !scrollEls.length) return;

    /* ambient glow layer (created once, desktop only) */
    var glow = null;
    function ensureGlow(){
      if (glow || document.querySelector('.ambient-glow')) return;
      glow = document.createElement('div');
      glow.className = 'ambient-glow';
      glow.setAttribute('aria-hidden', 'true');
      document.body.appendChild(glow);
    }
    function destroyGlow(){
      if (glow && glow.parentNode){ glow.parentNode.removeChild(glow); }
      glow = null;
    }

    /* ---- pointer parallax + ambient glow ---- */
    var lastX = 0, lastY = 0, ptrQueued = false, ptrActive = false;
    function onPointerFrame(){
      ptrQueued = false;
      if (glow){
        glow.style.setProperty('--mx', lastX + 'px');
        glow.style.setProperty('--my', lastY + 'px');
      }
      /* parallax: offset relative to viewport centre, scaled small */
      var cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      var nx = (lastX - cx) / cx;          /* -1 .. 1 */
      var ny = (lastY - cy) / cy;
      for (var i = 0; i < parallaxEls.length; i++){
        var el = parallaxEls[i];
        var kind = el.getAttribute('data-parallax');
        /* banana reacts more than the panel for depth */
        var amp = kind === 'banana' ? 16 : 7;
        var rot = kind === 'banana' ? (nx * 2.2) : 0;
        el.style.transform = 'translate3d(' + (nx * amp).toFixed(1) + 'px,' +
          (ny * amp).toFixed(1) + 'px,0)' + (rot ? ' rotate(' + rot.toFixed(2) + 'deg)' : '');
      }
    }
    function onPointerMove(e){
      lastX = e.clientX; lastY = e.clientY;
      if (!glow) ensureGlow();
      if (glow && !glow.classList.contains('lit')) glow.classList.add('lit');
      if (!ptrQueued && !document.hidden){ ptrQueued = true; requestAnimationFrame(onPointerFrame); }
    }
    function onPointerLeave(){
      /* ease art back to rest + fade the glow */
      for (var i = 0; i < parallaxEls.length; i++){ parallaxEls[i].style.transform = ''; }
      if (glow) glow.classList.remove('lit');
    }

    /* ---- scroll parallax: hero art drifts slower than the page ---- */
    var scrollQueued = false;
    function onScrollFrame(){
      scrollQueued = false;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      for (var i = 0; i < scrollEls.length; i++){
        var el = scrollEls[i];
        var rate = parseFloat(el.getAttribute('data-scroll-rate')) || 0.12;
        el.style.setProperty('--scrolly', (-(y * rate)).toFixed(1) + 'px');
      }
    }
    function onScroll(){
      if (!scrollQueued && !document.hidden){ scrollQueued = true; requestAnimationFrame(onScrollFrame); }
    }

    var bound = false;
    function bind(){
      if (bound) return; bound = true;
      ensureGlow();
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerleave', onPointerLeave, { passive: true });
      if (scrollEls.length){ window.addEventListener('scroll', onScroll, { passive: true }); onScrollFrame(); }
    }
    function unbind(){
      if (!bound) return; bound = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('scroll', onScroll);
      onPointerLeave();
      for (var i = 0; i < scrollEls.length; i++){ scrollEls[i].style.removeProperty('--scrolly'); }
      destroyGlow();
    }

    /* only run on desktop + a real (fine, hovering) pointer */
    function sync(){
      if (desktopMQ.matches && finePtrMQ.matches && !reduceMQ.matches){ bind(); }
      else { unbind(); }
    }
    sync();
    if (desktopMQ.addEventListener) desktopMQ.addEventListener('change', sync);
    else if (desktopMQ.addListener) desktopMQ.addListener(sync);
    if (finePtrMQ.addEventListener) finePtrMQ.addEventListener('change', sync);
    else if (finePtrMQ.addListener) finePtrMQ.addListener(sync);

    /* pause the cursor work while the tab is hidden (the rAF guards already
       skip queuing, but drop the lit glow so we resume cleanly) */
    document.addEventListener('visibilitychange', function(){
      if (document.hidden && glow) glow.classList.remove('lit');
    });
  })();

  /* ============================================================
     CONFETTI BURST — a short, on-brand "yay" moment.
     A fixed full-bleed layer of DOM particles in the brand colors
     (banana #FFD23F / #FFE177 + moss #3CF08A) that fall, sway, tumble
     and fade over ~1.2–1.6s, then the WHOLE layer is removed. Pure
     transform/opacity CSS keyframes (see .bb-confetti* in site.css) so
     each piece composites on the GPU — the JS only mints the nodes and
     sets per-piece CSS vars, then schedules the cleanup.

     TRIGGERS:
       (a) a GENTLE burst when the HOME page first loads on MOBILE — once
           per browser session (sessionStorage), fired AFTER first paint so
           it never blocks load.
       (b) a CELEBRATORY burst when a "Start a project" CTA is tapped on ANY
           page (the delightful moment). Lighter count on desktop, which
           already has lots of motion.

     GUARDS:
       • never fires under prefers-reduced-motion
       • never fires (and is skipped, not queued) while the tab is hidden
       • the layer is pointer-events:none + contain:strict so it can't
         create scrollbars or eat taps; z-index 94 sits below the drawer (96)
       • each fire reuses ONE layer; rapid taps don't stack dozens of layers
     ============================================================ */
  (function confetti(){
    var COLORS = ['#FFD23F', '#FFE177', '#3CF08A'];   /* banana ×2 + moss-green */
    var layer = null, cleanupTimer = null;

    function destroy(){
      if (cleanupTimer){ clearTimeout(cleanupTimer); cleanupTimer = null; }
      if (layer && layer.parentNode){ layer.parentNode.removeChild(layer); }
      layer = null;
    }

    /* fire(opts): opts.count (pieces), opts.origin {x,y in 0..1 of viewport},
       opts.spread (px horizontal scatter), opts.pop (draw the origin ring). */
    function fire(opts){
      /* hard guards — no motion preference, or tab not visible → skip entirely */
      if (reduceMQ.matches || document.hidden) return;
      opts = opts || {};

      var count   = opts.count   || 80;
      var origin  = opts.origin  || { x: 0.5, y: 0.4 };
      var spread  = opts.spread  || Math.min(window.innerWidth, 560);
      var ox      = origin.x * window.innerWidth;
      var oy      = origin.y * window.innerHeight;

      /* fresh layer per burst (tearing down any in-flight one first so taps
         don't accumulate stale layers) */
      destroy();
      layer = document.createElement('div');
      layer.className = 'bb-confetti';
      layer.setAttribute('aria-hidden', 'true');

      var frag = document.createDocumentFragment();
      var maxDur = 0;

      /* origin pop ring — the little firework "flash" at the burst point */
      if (opts.pop){
        var ring = document.createElement('span');
        ring.className = 'bb-confetti-pop';
        ring.style.setProperty('--ox', ox.toFixed(0) + 'px');
        ring.style.setProperty('--oy', oy.toFixed(0) + 'px');
        frag.appendChild(ring);
        if (550 > maxDur) maxDur = 550;
      }

      for (var i = 0; i < count; i++){
        var p = document.createElement('span');
        var spark = Math.random() < 0.34;          /* ~1/3 round "spark" pops */
        p.className = 'bb-confetti-piece' + (spark ? ' spark' : '');

        var size = spark ? rand(5, 9) : rand(7, 12);
        p.style.setProperty('--w', size.toFixed(1) + 'px');
        p.style.setProperty('--h', (spark ? size : size * rand(1.2, 1.8)).toFixed(1) + 'px');
        p.style.setProperty('--c', COLORS[(Math.random() * COLORS.length) | 0]);
        p.style.setProperty('--br', spark ? '50%' : (rand(1, 3)).toFixed(0) + 'px');

        /* start each piece at the burst origin, scattered horizontally */
        var startX = ox + rand(-spread / 2, spread / 2);
        p.style.left = startX.toFixed(0) + 'px';
        p.style.top  = oy.toFixed(0) + 'px';

        /* per-piece motion vars the keyframes read */
        p.style.setProperty('--x',    '0px');
        p.style.setProperty('--sway', rand(-90, 90).toFixed(0) + 'px');
        p.style.setProperty('--fall', rand(70, 116).toFixed(0) + 'vh');
        p.style.setProperty('--spin', (rand(-720, 720)).toFixed(0) + 'deg');
        var dur = rand(1.15, 1.6);
        var delay = rand(0, 0.18);
        p.style.setProperty('--dur', dur.toFixed(2) + 's');
        p.style.setProperty('--delay', delay.toFixed(2) + 's');
        if ((dur + delay) * 1000 > maxDur) maxDur = (dur + delay) * 1000;

        frag.appendChild(p);
      }

      layer.appendChild(frag);
      document.body.appendChild(layer);

      /* auto-clean once the longest piece has finished (+ a small buffer) */
      cleanupTimer = setTimeout(destroy, maxDur + 120);
    }

    /* if the tab is hidden mid-flight, tear the layer down (it'd otherwise
       resume mid-animation on return looking stale) */
    document.addEventListener('visibilitychange', function(){
      if (document.hidden && layer) destroy();
    });

    /* ---- TRIGGER (a): gentle burst on first HOME load (MOBILE, once/session) */
    var isHome = (function(){
      var p = location.pathname.replace(/\/+$/, '');   /* trim trailing slash */
      return p === '' || p === '/index.html';
    })();
    var SESSION_KEY = 'bb-confetti-home';
    function seenThisSession(){
      try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch(e){ return false; }
    }
    function markSeen(){
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch(e){ /* private mode — fine */ }
    }

    if (isHome && mq.matches && !reduceMQ.matches && !seenThisSession()){
      markSeen();   /* set immediately so a fast navigate-away/back won't double-fire */
      /* fire AFTER first paint so we never block load; two rAFs = next frame */
      requestAnimationFrame(function(){
        requestAnimationFrame(function(){
          if (document.hidden) return;   /* re-check: don't fire into a hidden tab */
          fire({ count: 70, origin: { x: 0.5, y: 0.30 }, spread: window.innerWidth * 0.9, pop: false });
        });
      });
    }

    /* ---- TRIGGER (b): celebratory burst when a "Start a project" CTA is tapped.
       Delegated so it covers the header CTA, the drawer CTA and any in-page
       CTA. We DON'T preventDefault — the link still navigates to /contact/;
       the confetti just plays on the way out. Lighter on desktop (it already
       has plenty of motion); a fuller pop on mobile. */
    document.addEventListener('click', function(e){
      var a = e.target.closest('a[href]');
      if (!a) return;
      /* "Start a project" CTAs are the contact-bound CTA buttons */
      var href = a.getAttribute('href') || '';
      var isContact = /\/contact\/?($|[?#])/.test(href);
      var isCTA = a.classList.contains('nav-cta') || a.classList.contains('mm-cta') || a.classList.contains('btn-primary');
      if (!isContact || !isCTA) return;
      if (reduceMQ.matches || document.hidden) return;

      /* burst from the tapped button's centre (so it reads as "from the CTA") */
      var r = a.getBoundingClientRect();
      var origin = {
        x: (r.left + r.width / 2) / window.innerWidth,
        y: (r.top + r.height / 2) / window.innerHeight
      };
      var desktop = desktopMQ.matches;
      fire({
        count: desktop ? 60 : 100,
        origin: origin,
        spread: desktop ? 360 : window.innerWidth * 0.8,
        pop: true
      });
    }, true);   /* capture: fire before any same-target handler that might stop propagation */
  })();

  /* ============================================================
     AI FRONT DESK — the live bilingual chat widget.

     This is the working demo of the "AI Front Desk" service: a floating
     launcher (bottom-right) opens an on-brand chat panel. On send it POSTs
     the running transcript to the same-origin /api/chat Worker, which calls
     OpenRouter with a BananaByte system persona and returns {reply}.

     • Injected here so it appears on EVERY page — no per-page markup.
     • Bilingual: all UI copy + the greeting follow the existing LANG state
       (and re-render live if the visitor flips EN/ES while it's open).
     • Keeps only the last ~8 turns client-side (the worker also caps).
     • Accessible: dialog role, labelled controls, focus move + trap, Esc to
       close, Enter to send. Open/close animation is reduced-motion aware.
     ============================================================ */
  (function chatWidget(){
    var MAX_TURNS = 8;   /* user+assistant pairs kept in the transcript */

    /* bilingual copy — resolved live against the page-level LANG var */
    var CW = {
      en: {
        launch:  'Chat with BananaByte',
        title:   'BananaByte Assistant',
        sub:     'AI front desk · replies in seconds',
        close:   'Close chat',
        greet:   "Hi! 🍌 Ask me anything about BananaByte — sites, pricing, getting started.",
        ph:      'Type your message…',
        send:    'Send',
        sending: 'Thinking…',
        error:   "I'm having a hiccup — text Gabe at (321) 202-3732 or use the contact page."
      },
      es: {
        launch:  'Chatea con BananaByte',
        title:   'Asistente BananaByte',
        sub:     'Recepción con IA · responde en segundos',
        close:   'Cerrar chat',
        greet:   "¡Hola! 🍌 Pregúntame lo que quieras sobre BananaByte — sitios, precios, cómo empezar.",
        ph:      'Escribe tu mensaje…',
        send:    'Enviar',
        sending: 'Pensando…',
        error:   "Tuve un problemita — escríbele a Gabe al (321) 202-3732 o usa la página de contacto."
      }
    };
    function cw(k){ return (CW[LANG] || CW.en)[k]; }

    /* the running transcript (user/assistant only; system lives server-side) */
    var history = [];
    var busy = false;
    var greeted = false;
    var lastFocus = null;

    /* ---- transcript logging: email the finished convo to the owner ----
       A stable per-session id so the worker can de-dupe a close + an unload
       beacon. 'logged' is the once-per-session guard (set true after we beacon)
       so the two end triggers never double-send. */
    var SESSION_CONVO_KEY = 'bb-chat-convo';
    function convoId(){
      try {
        var id = sessionStorage.getItem(SESSION_CONVO_KEY);
        if (!id){
          id = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
          sessionStorage.setItem(SESSION_CONVO_KEY, id);
        }
        return id;
      } catch(e){
        /* private mode — fall back to a per-load id (still de-dupes within load) */
        if (!convoId._mem) convoId._mem = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        return convoId._mem;
      }
    }
    var logged = false;
    /* Fire-and-forget the transcript when the conversation ENDS, but only on a
       REAL exchange (≥1 user AND ≥1 assistant) and only ONCE per session. Uses
       sendBeacon so it survives the page being closed/unloaded. */
    function logTranscript(){
      if (logged) return;
      var hasUser = false, hasAssistant = false;
      for (var i = 0; i < history.length; i++){
        if (history[i].role === 'user') hasUser = true;
        else if (history[i].role === 'assistant') hasAssistant = true;
      }
      if (!hasUser || !hasAssistant) return;   /* skip greeting-only / empty chats */
      logged = true;                            /* set before sending — never double-fire */
      try {
        var payload = JSON.stringify({
          convoId: convoId(),
          lang: LANG,
          url: location.pathname,
          messages: history
        });
        navigator.sendBeacon('/api/chat-log', new Blob([payload], { type: 'application/json' }));
      } catch(e){ /* fire-and-forget — never throw on unload */ }
    }

    /* ---- build the DOM once ---- */
    var launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'bb-chat-launch';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.innerHTML =
      '<span class="bb-chat-launch-ic" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l2-5.5A8.5 8.5 0 1 1 21 11.5z"/>' +
        '</svg>' +
        '<span class="bb-chat-launch-emoji" aria-hidden="true">🍌</span>' +
      '</span>';

    var panel = document.createElement('div');
    panel.className = 'bb-chat-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', cw('title'));
    panel.hidden = true;
    panel.innerHTML =
      '<div class="bb-chat-head">' +
        '<div class="bb-chat-head-txt">' +
          '<span class="bb-chat-title"></span>' +
          '<span class="bb-chat-sub"></span>' +
        '</div>' +
        '<button type="button" class="bb-chat-close" aria-label="">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="bb-chat-log" role="log" aria-live="polite" aria-atomic="false" tabindex="0"></div>' +
      '<form class="bb-chat-form">' +
        '<input type="text" class="bb-chat-input" autocomplete="off" aria-label="" />' +
        '<button type="submit" class="bb-chat-send" aria-label="">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>' +
        '</button>' +
      '</form>';

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    /* handles */
    var elTitle = panel.querySelector('.bb-chat-title');
    var elSub   = panel.querySelector('.bb-chat-sub');
    var elClose = panel.querySelector('.bb-chat-close');
    var elLog   = panel.querySelector('.bb-chat-log');
    var elForm  = panel.querySelector('.bb-chat-form');
    var elInput = panel.querySelector('.bb-chat-input');
    var elSend  = panel.querySelector('.bb-chat-send');

    /* ---- localized static labels (re-applied on language change) ---- */
    function applyChatLang(){
      launcher.setAttribute('aria-label', cw('launch'));
      panel.setAttribute('aria-label', cw('title'));
      elTitle.textContent = cw('title');
      elSub.textContent   = cw('sub');
      elClose.setAttribute('aria-label', cw('close'));
      elInput.setAttribute('placeholder', cw('ph'));
      elInput.setAttribute('aria-label', cw('ph'));
      elSend.setAttribute('aria-label', cw('send'));
      /* if the greeting bubble is showing and nothing's been said yet, retranslate it */
      if (greeted && history.length === 0){
        var g = elLog.querySelector('.bb-chat-msg.assistant .bb-chat-bubble');
        if (g) g.textContent = cw('greet');
      }
    }
    applyChatLang();

    /* ---- message rendering ---- */
    function addMsg(role, text){
      var row = document.createElement('div');
      row.className = 'bb-chat-msg ' + role;
      var bubble = document.createElement('div');
      bubble.className = 'bb-chat-bubble';
      bubble.textContent = text;
      row.appendChild(bubble);
      elLog.appendChild(row);
      elLog.scrollTop = elLog.scrollHeight;
      return bubble;
    }
    function addTyping(){
      var row = document.createElement('div');
      row.className = 'bb-chat-msg assistant bb-chat-typing-row';
      row.innerHTML = '<div class="bb-chat-bubble bb-chat-typing" aria-hidden="true"><span></span><span></span><span></span></div>';
      elLog.appendChild(row);
      elLog.scrollTop = elLog.scrollHeight;
      return row;
    }

    /* ---- open / close ---- */
    function panelFocusable(){
      return Array.prototype.slice.call(
        panel.querySelectorAll('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter(function(el){ return el.offsetParent !== null && !el.disabled; });
    }
    function onPanelKey(e){
      if (e.key === 'Escape'){ e.preventDefault(); closeChat(); return; }
      if (e.key === 'Tab'){
        var f = panelFocusable();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
      }
    }
    function openChat(){
      if (!panel.hidden) return;
      lastFocus = document.activeElement;
      panel.hidden = false;
      void panel.offsetWidth;                 /* allow layout before the open transition */
      panel.classList.add('open');
      launcher.classList.add('open');
      launcher.setAttribute('aria-expanded', 'true');
      docEl.classList.add('bb-chat-open');     /* CSS locks body scroll on mobile */
      if (!greeted){ greeted = true; addMsg('assistant', cw('greet')); }
      document.addEventListener('keydown', onPanelKey, true);
      /* focus the input so a visitor can type immediately */
      setTimeout(function(){ elInput.focus(); }, reduceMQ.matches ? 0 : 60);
    }
    function closeChat(returnFocus){
      if (panel.hidden) return;
      logTranscript();   /* the visitor ended the conversation — log it (once) */
      panel.classList.remove('open');
      launcher.classList.remove('open');
      launcher.setAttribute('aria-expanded', 'false');
      docEl.classList.remove('bb-chat-open');
      document.removeEventListener('keydown', onPanelKey, true);
      var done = function(){ panel.hidden = true; panel.removeEventListener('transitionend', done); };
      if (reduceMQ.matches){ done(); } else { panel.addEventListener('transitionend', done); setTimeout(done, 320); }
      if (returnFocus !== false && launcher){ launcher.focus(); }
    }

    launcher.addEventListener('click', function(){
      if (panel.hidden) openChat(); else closeChat();
    });
    elClose.addEventListener('click', function(){ closeChat(); });

    /* ---- send ---- */
    function send(text){
      text = (text || '').trim();
      if (!text || busy) return;
      busy = true;
      elSend.disabled = true;

      addMsg('user', text);
      history.push({ role: 'user', content: text });
      /* keep only the last ~8 turns (16 messages) */
      if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);

      elInput.value = '';
      var typing = addTyping();

      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ messages: history })
      })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(r){
          if (typing.parentNode) typing.parentNode.removeChild(typing);
          var reply = r.j && typeof r.j.reply === 'string' ? r.j.reply : '';
          if (reply){
            addMsg('assistant', reply);
            history.push({ role: 'assistant', content: reply });
            if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);
          } else {
            addMsg('assistant', cw('error'));
          }
        })
        .catch(function(){
          if (typing.parentNode) typing.parentNode.removeChild(typing);
          addMsg('assistant', cw('error'));
        })
        .finally(function(){
          busy = false;
          elSend.disabled = false;
          if (!panel.hidden) elInput.focus();
        });
    }

    elForm.addEventListener('submit', function(e){
      e.preventDefault();
      send(elInput.value);
    });

    /* ---- end-of-conversation logging on page exit ----
       Closing the panel logs the transcript; but a visitor often just leaves
       the page (or backgrounds the tab) with the chat still open. 'pagehide'
       covers navigation/close/bfcache; 'visibilitychange'→hidden covers tab
       switches and mobile app-switch/lock (the most reliable unload signal on
       mobile). logTranscript()'s once-per-session guard makes the overlap safe. */
    window.addEventListener('pagehide', logTranscript);
    document.addEventListener('visibilitychange', function(){
      if (document.hidden) logTranscript();
    });

    /* ---- re-render copy when the page language flips while we're mounted.
       The footer lang buttons call applyLang(); we mirror that by watching the
       <html> lang-class the toggle sets, so EN/ES stays in sync live. ---- */
    if (window.MutationObserver){
      var lastLang = LANG;
      var langObs = new MutationObserver(function(){
        if (LANG !== lastLang){ lastLang = LANG; applyChatLang(); }
      });
      langObs.observe(docEl, { attributes: true, attributeFilter: ['class', 'lang'] });
    }
  })();

})();
