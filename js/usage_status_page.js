/*
 * usage_status_page.js - page half of "Usage and session status" (Windows
 * build), injected by js/usage_status_main.js into claude.ai pages.
 *
 * Ported from UI+ for Claude (MIT, (c) Lukas van Uden,
 * https://github.com/LukasvanUden/ui-plus-for-claude, Extension/widget.js):
 * plan usage with pace in the sidebar and Claude's usage popover, a state
 * badge on each session, the session's context in the popover and per-session
 * colors. Runs in the page's own world, so React fibers are readable here.
 *
 * Reads var __CDB_USAGE_STATUS_OPTS = { enabled } (set by the main module).
 * Idempotent: every run first calls window.__cdbUsageStatusTeardown() of the
 * previous run; with enabled false it stops there, leaving nothing behind.
 */
(function () {
  const WIDGET_ID = 'usage-pace';
  const HOUR_MS = 3_600_000;
  const WINDOW_MS = { session: 5 * HOUR_MS, weekly_all: 7 * 24 * HOUR_MS, weekly_scoped: 7 * 24 * HOUR_MS };
  const ON_PACE_POINTS = 3;
  const POLL_MS = 60_000;
  // Until there is usage to show (signing in, switching accounts), ask sooner.
  const RETRY_MS = 5_000;
  // A request that hangs, as one can while Claude switches accounts, must not
  // stop the polling.
  const FETCH_TIMEOUT_MS = 15_000;
  const ACCOUNT_CHECK_MS = 2_000;
  const GAUGE_PATHS = ['M3.8 14.2a6.8 6.8 0 1 1 12.4 0', 'M10 11.2l3.2-3.4'];

  const STRINGS = {
    en: {
      title: 'Usage',
      fiveHour: 'Session limit',
      weekly: (name) => 'Weekly \u00b7 ' + name,
      allModels: 'all models',
      hoursMinutes: (h, m) => (h > 0 ? h + ' hr ' : '') + m + ' min',
      over: (d) => d + '% over pace',
      under: (d) => d + '% under pace',
      onPace: 'On pace',
      badges: { awaiting: 'Waiting', ready: 'Ready', error: 'Error' },
      context: 'Context',
      used: (percent) => percent + ' used',
      compact: 'Compact session',
      showRail: 'Show session rail',
      color: 'Color',
      noColor: 'No color',
    },
    de: {
      title: 'Nutzung',
      fiveHour: 'Sitzungslimit',
      weekly: (name) => 'W\u00f6chentlich \u00b7 ' + name,
      allModels: 'alle Modelle',
      hoursMinutes: (h, m) => (h > 0 ? h + ' Std. ' : '') + m + ' Min.',
      over: (d) => d + ' % \u00fcber Plan',
      under: (d) => d + ' % unter Plan',
      onPace: 'Im Plan',
      badges: { awaiting: 'Wartet', ready: 'Fertig', error: 'Fehler' },
      context: 'Kontext',
      used: (percent) => percent + ' genutzt',
      compact: 'Sitzung komprimieren',
      showRail: 'Sitzungsleiste anzeigen',
      color: 'Farbe',
      noColor: 'Keine Farbe',
    },
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatReset(resetAt, kind, now, strings, locale) {
    if (resetAt === null) return null;
    if (kind === 'session') {
      const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
      return strings.hoursMinutes(Math.floor(minutes / 60), minutes % 60);
    }
    return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      .format(new Date(resetAt));
  }

  // Same rows as Claude's own usage popover, which reads the `limits` list;
  // older responses only have the five_hour and seven_day windows.
  function limitsOf(usage) {
    if (Array.isArray(usage?.limits)) return usage.limits;
    return [
      { kind: 'session', percent: usage?.five_hour?.utilization, resets_at: usage?.five_hour?.resets_at },
      { kind: 'weekly_all', percent: usage?.seven_day?.utilization, resets_at: usage?.seven_day?.resets_at },
    ];
  }

  function buildView(usage, now, lang, locale) {
    if (!usage) return null;
    const strings = STRINGS[lang] ?? STRINGS.en;
    let pace = null;
    const rows = limitsOf(usage).flatMap((limit) => {
      const windowMs = WINDOW_MS[limit?.kind];
      const model = String(limit?.scope?.model?.display_name ?? '').trim();
      if (!windowMs || !Number.isFinite(limit.percent) || (limit.kind === 'weekly_scoped' && !model)) return [];

      const label = limit.kind === 'session'
        ? strings.fiveHour
        : strings.weekly(limit.kind === 'weekly_all' ? strings.allModels : model);
      const used = clamp(Math.floor(limit.percent), 0, 100);
      const parsedReset = Date.parse(limit.resets_at ?? '');
      const resetAt = Number.isFinite(parsedReset) ? parsedReset : null;
      const elapsed = resetAt === null ? null : clamp(100 - ((resetAt - now) / windowMs) * 100, 0, 100);

      if (limit.kind === 'weekly_all' && elapsed !== null) {
        const delta = Math.round(used - elapsed);
        pace = Math.abs(delta) <= ON_PACE_POINTS ? strings.onPace : delta > 0 ? strings.over(delta) : strings.under(-delta);
      }
      const time = elapsed === null
        ? null
        : { shared: Math.min(used, elapsed), end: Math.max(used, elapsed), over: used > elapsed };
      const reset = formatReset(resetAt, limit.kind, now, strings, locale);
      return [{ kind: limit.kind, model, label, used, time, meta: (reset ? reset + ' \u00b7 ' : '') + used + '%' }];
    });
    return { rows, pace };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { buildView };
  }
  if (typeof document === 'undefined') return;

  // Teardown of an earlier run, then stop when the switch is off.
  if (typeof window.__cdbUsageStatusTeardown === 'function') {
    try { window.__cdbUsageStatusTeardown(); } catch {}
  }
  window.__cdbUsageStatusTeardown = null;
  const opts = typeof __CDB_USAGE_STATUS_OPTS === 'object' && __CDB_USAGE_STATUS_OPTS ? __CDB_USAGE_STATUS_OPTS : {};
  if (opts.enabled !== true) return;

  const SECTION_HEADERS = /^(Projects|Projekte|Pinned|Angeheftet|Recents|Zuletzt verwendet|Ungrouped|Nicht gruppiert)$/i;
  const MORE = /^(More|Mehr)$/i;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Preferences live in claude.ai's localStorage, under the add-on's first
  // name, Usage Pace; everything defaults to on.
  function stored(key) {
    try {
      return localStorage.getItem('usage-pace:' + key);
    } catch {
      return null;
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem('usage-pace:' + key, typeof value === 'string' ? value : value ? '1' : '0');
    } catch {}
  }

  let collapsed = stored('collapsed') === '1';
  // Everything a run starts is stopped through these on teardown.
  const stop = new AbortController();
  const observers = [];
  let stopped = false;
  let accountTimer = null;
  let usage = null;
  let view = null;
  let version = 0;
  let widget = null;
  let header = null;
  let headerLabel = null;
  let headerPace = null;
  let rows = null;
  let before = null;
  let scheduled = null;
  let timer = null;

  function strings() {
    return STRINGS[language()] ?? STRINGS.en;
  }

  function language() {
    return (document.documentElement.lang || navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en';
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function findLabel(pattern) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || parent.closest('#' + WIDGET_ID)) continue;
      if (pattern.test(node.nodeValue.trim()) && visible(parent)) return parent;
    }
    return null;
  }

  // Grey up to where usage and time agree; the colored segment below it
  // spans to whichever of the two is further along.
  function timeLine(time, className) {
    const line = element('div', 'up-time ' + className);
    line.dataset.version = String(version);
    if (time) {
      const difference = element('div', 'up-segment ' + (time.over ? 'up-segment-over' : 'up-segment-buffer'));
      difference.style.width = time.end + '%';
      const shared = element('div', 'up-segment up-segment-elapsed');
      shared.style.width = time.shared + '%';
      line.append(difference, shared);
    }
    return line;
  }

  // Sidebar -----------------------------------------------------------------

  // The widget goes right before the sidebar's recents/projects block. Claude's
  // layout classes work in every language; the block keeps the lists of the
  // other modes (chat, cowork, code) mounted but hidden, so the first label
  // that shows belongs to the current one. The English and German labels are
  // the fallback: the lowest container holding "More" and the first section
  // header, right before the block with that header. The More row can show
  // the page last opened from its menu instead, and a "More" elsewhere would
  // make that container the whole window: it has to be a narrow column.
  function findSlot() {
    const label = [...document.querySelectorAll('.dframe-nav-scroll > .dframe-recents-by-mode .df-label-inset span')].find(visible);
    const recents = label?.closest('.dframe-recents-by-mode');
    if (recents) return { parent: recents.parentElement, before: recents, header: label };

    const more = findLabel(MORE);
    const sectionHeader = more && findLabel(SECTION_HEADERS);
    if (!sectionHeader) return null;
    let parent = more.parentElement;
    while (parent && !parent.contains(sectionHeader)) parent = parent.parentElement;
    if (!parent || parent.getBoundingClientRect().width > window.innerWidth / 2) return null;
    let block = sectionHeader;
    while (block.parentElement !== parent) block = block.parentElement;
    return { parent, before: block, header: sectionHeader };
  }

  function setCollapsed(value) {
    collapsed = value;
    store('collapsed', value);
    widget.classList.toggle('up-collapsed', value);
    header?.setAttribute('aria-expanded', String(!value));
  }

  function gaugeIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.setAttribute('fill', 'none');
    svg.append(...GAUGE_PATHS.map((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      return path;
    }));
    return svg;
  }

  // "Usage" is a copy of the sidebar's last row ("More"), so it looks and
  // hovers like its neighbours. React ignores the copy, so clicks stay ours.
  function buildHeader(group) {
    const template = [...(group?.querySelectorAll('button') ?? [])].pop();
    const button = template ? template.cloneNode(true) : element('button');
    // Claude draws icons with an icon font: the gauge replaces the glyph and
    // takes its size from the icon's font size.
    const icon = button.querySelector('[data-cds="Icon"], svg');
    const gauge = gaugeIcon();
    if (icon instanceof SVGElement) icon.replaceWith(gauge);
    else if (icon) icon.replaceChildren(gauge);
    else button.prepend(gauge);
    for (const node of [button, ...button.querySelectorAll('*')]) {
      for (const { name } of [...node.attributes]) {
        if (name === 'id' || name.startsWith('aria-') || name.startsWith('data-')) node.removeAttribute(name);
      }
    }
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue.trim()) texts.push(node);
    texts.slice(1).forEach((node) => node.remove());
    headerLabel = texts[0]?.parentElement ?? button.appendChild(element('span'));
    headerPace = element('span', 'up-pace');
    button.append(headerPace);
    button.type = 'button';
    button.classList.add('up-header');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCollapsed(!collapsed);
    });
    return button;
  }

  function renderSidebar() {
    if (!widget) {
      widget = element('div');
      widget.id = WIDGET_ID;
      rows = element('div', 'up-rows');
      widget.append(rows);
    }
    rows.replaceChildren(...view.rows.map((row) => {
      const top = element('div', 'up-top');
      top.append(element('span', 'up-label', row.label), element('span', 'up-meta', row.meta));
      const track = element('div', 'up-track');
      const fill = element('div', 'up-fill');
      fill.style.width = row.used + '%';
      track.append(fill);
      const container = element('div', 'up-row');
      container.append(top, timeLine(row.time, 'up-in-sidebar'), track);
      return container;
    }));
    if (header) {
      headerLabel.textContent = strings().title;
      headerPace.textContent = view.pace ?? '';
    }
  }

  function place() {
    if (!widget) return;
    if (!view) {
      widget.remove();
      return;
    }
    if (widget.isConnected && before?.isConnected && widget.nextElementSibling === before) return;
    const slot = findSlot();
    if (!slot) {
      widget.remove();
      return;
    }
    before = slot.before;
    if (!header) {
      const group = before.previousElementSibling === widget ? widget.previousElementSibling : before.previousElementSibling;
      header = buildHeader(group);
      widget.prepend(header);
      setCollapsed(collapsed);
      renderSidebar();
    }
    const inset = slot.header.getBoundingClientRect().left - slot.parent.getBoundingClientRect().left;
    rows.style.padding = '0 ' + Math.max(8, Math.round(inset)) + 'px';
    slot.parent.insertBefore(widget, before);
  }

  // Popover -----------------------------------------------------------------

  // Claude's usage popover: its header links to /settings/usage, the limits
  // follow right after it, and each limit is a meter (a progressbar in older
  // versions) labelled by its row title. The link sits directly in the header
  // or in a group of icon buttons at its end.
  function usageSection() {
    const root = document.getElementById('portal-root') ?? document.body;
    const link = root.querySelector('[data-cds="Popover"] a[href="/settings/usage"]');
    let headerRow = link?.parentElement;
    while (headerRow && !headerRow.nextElementSibling && headerRow.parentElement?.closest('[data-cds="Popover"]')) {
      headerRow = headerRow.parentElement;
    }
    const list = headerRow?.nextElementSibling;
    if (!list) return null;
    const end = [...headerRow.children].find((child) => child.contains(link));
    return { end, headerRow, list };
  }

  const BAR = '[role="meter"], [role="progressbar"]';

  // The time line goes right above the bar: above Claude's meter element, or
  // above the progressbar itself.
  function barBlock(bar) {
    return bar.closest('[data-cds="Meter"]') ?? bar;
  }

  // Claude's popover titles the weekly limit for all models just "Weekly".
  const POPOVER_TITLES = {
    session: /^(Session limit|Sitzungslimit|5-Stunden-Limit)$/i,
    weekly_all: /^(Weekly|W\u00f6chentlich)( \u00b7 (all models|alle Modelle))?$/i,
  };

  function rowTitled(title) {
    if (!title) return null;
    return view.rows.find((row) => row.label === title)
      ?? view.rows.find((row) => POPOVER_TITLES[row.kind]?.test(title))
      ?? view.rows.find((row) => row.kind === 'weekly_scoped' && title.includes(row.model))
      ?? null;
  }

  function titleOf(bar) {
    const ids = (bar.getAttribute('aria-labelledby') || barBlock(bar).getAttribute('aria-labelledby') || '').split(/\s+/);
    for (const id of ids) {
      const text = id && document.getElementById(id)?.textContent.trim();
      if (text) return text;
    }
    return null;
  }

  // Runs on every DOM change, so it only touches what is missing or outdated
  // and never triggers itself again.
  function enhancePopover() {
    const section = usageSection();
    if (!section) return;
    const { end, headerRow, list } = section;
    const bars = [...list.querySelectorAll(BAR)];
    // Claude groups the limit rows in one inset block; blocks below it, such
    // as cloud session credits, have meters of their own. Older popovers list
    // the rows directly, each with its bar as a direct child.
    const rowsBlock = bars.length > 0 ? [...list.children].find((child) => child.contains(bars[0])) : null;
    const limits = rowsBlock && !rowsBlock.querySelector(':scope > :is(' + BAR + ', [data-cds="Meter"])') ? rowsBlock : list;

    // Only one context block, first in the limits block: an earlier render
    // may have placed one elsewhere before the popover finished loading.
    for (const block of list.querySelectorAll('.up-context')) {
      if (block.parentElement !== limits) block.remove();
    }
    syncContext(limits);

    let pace = headerRow.querySelector(':scope > .up-popover-pace');
    if (!view) {
      pace?.remove();
      bars.forEach((bar) => {
        const previous = barBlock(bar).previousElementSibling;
        if (previous?.classList.contains('up-time')) previous.remove();
      });
      return;
    }

    if (!pace) {
      pace = element('span', 'up-popover-pace');
      headerRow.insertBefore(pace, end ?? null);
    }
    if (pace.textContent !== (view.pace ?? '')) pace.textContent = view.pace ?? '';

    // Time lines only for the limits, not for meters such as credits.
    const limitBars = bars.filter((bar) => limits.contains(bar));
    limitBars.forEach((bar, index) => {
      const block = barBlock(bar);
      const row = rowTitled(titleOf(bar)) ?? (limitBars.length === view.rows.length ? view.rows[index] : null);
      const current = block.previousElementSibling?.classList.contains('up-time') ? block.previousElementSibling : null;
      if (!row?.time) {
        current?.remove();
        return;
      }
      let line = current;
      if (current?.dataset.version !== String(version)) {
        line = timeLine(row.time, 'up-in-popover');
        if (current) current.replaceWith(line);
        else block.before(line);
      }
      // Near the limit Claude paints its bar in a warning color instead of
      // the accent; the "over" segment then turns red to stay distinct.
      // Claude's meter names its color; for a plain progressbar, .up-time
      // carries the accent as its invisible outline color to compare with.
      const fill = bar.querySelector('[data-usage-bar-fill]') ?? bar.firstElementChild;
      const variant = block.dataset.variant;
      const warning = variant
        ? variant !== 'accent'
        : Boolean(fill) && getComputedStyle(fill).backgroundColor !== getComputedStyle(line).outlineColor;
      line.classList.toggle('up-on-warning', warning);
    });
  }

  // Context -----------------------------------------------------------------

  // Claude moved the session's context usage and "Compact session" out of
  // this popover into the Context card of the session rail, right of the
  // conversation. The card stays mounted while collapsed and marks its
  // headline with data-rail-context-summary and data-rail-context-pct, so the
  // popover mirrors it above the limits, with a button that presses the
  // card's own, and a copy of the card's bar colored by what fills the
  // context (messages, tools, skills...). With the rail hidden, the button
  // shows the rail instead.
  const COMPACT = /^(Compact session|Sitzung komprimieren)$/i;
  const SHOW_RAIL = 'button[aria-label="Show session rail"], button[aria-label="Sitzungsleiste anzeigen"]';

  function railContext() {
    const summary = document.querySelector('section [data-rail-context-summary]');
    if (!summary) return null;
    const pct = Number(summary.getAttribute('data-rail-context-pct') ?? NaN);
    const section = summary.closest('section');
    const compact = [...section.querySelectorAll('button')].find((button) => COMPACT.test(button.textContent.trim())) ?? null;
    const bar = section.querySelector('[data-cds="StackedMeter"]');
    return { text: summary.textContent.trim(), pct: Number.isFinite(pct) ? clamp(pct, 0, 100) : null, compact, bar };
  }

  // Same markup and classes as the rows of Claude's popover; only the bar is
  // drawn by widget.css.
  function buildContext() {
    const block = element('div', 'up-context flex flex-col gap-xs');
    const head = element('div', 'flex items-baseline justify-between gap-sm text-body');
    head.append(
      element('span', 'up-context-title min-w-0 font-medium text-primary'),
      element('span', 'up-context-value shrink-0 whitespace-nowrap text-footnote tabular-nums text-muted-as-secondary'),
    );
    const track = element('div', 'up-context-track');
    track.append(element('div', 'up-context-fill'));
    const stacked = element('div', 'up-context-stacked');
    const foot = element('div', 'up-context-foot text-footnote text-muted-as-secondary');
    foot.append(
      element('span', 'up-context-caption'),
      linkButton('up-context-action', '', () => {
        const context = railContext();
        (context ? context.compact : document.querySelector(SHOW_RAIL))?.click();
      }),
    );
    block.append(head, track, stacked, foot);
    return block;
  }

  // What each popover's bar copy was made from, to copy again on changes.
  const barSources = new WeakMap();

  // A copy that keeps the look but nothing to focus, hover or point to.
  function quietCopy(node) {
    const copy = node.cloneNode(true);
    for (const element of [copy, ...copy.querySelectorAll('*')]) {
      for (const { name } of [...element.attributes]) {
        if (name === 'id' || name === 'tabindex' || name === 'role' || name.startsWith('aria-')) element.removeAttribute(name);
      }
    }
    copy.setAttribute('aria-hidden', 'true');
    return copy;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function setHidden(node, hidden) {
    if (node.hidden !== hidden) node.hidden = hidden;
  }

  function syncContext(host) {
    let block = host.querySelector(':scope > .up-context');
    const context = railContext();
    const showRail = context ? null : document.querySelector(SHOW_RAIL);
    if (!context && !showRail) {
      block?.remove();
      return;
    }
    if (!block) block = buildContext();
    if (host.firstElementChild !== block) host.prepend(block);

    const text = strings();
    const pct = context?.pct ?? null;
    const percent = pct === null
      ? ''
      : new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'percent', maximumFractionDigits: 0 }).format(pct / 100);
    setText(block.querySelector('.up-context-title'), text.context);
    setText(block.querySelector('.up-context-value'), pct === null ? (context?.text ?? '') : text.used(percent));
    setText(block.querySelector('.up-context-caption'), pct === null ? '' : context.text);
    // Claude's colored bar where the card has one, else a plain bar.
    const stacked = block.querySelector('.up-context-stacked');
    const source = context?.bar?.outerHTML ?? '';
    if ((barSources.get(stacked) ?? '') !== source) {
      barSources.set(stacked, source);
      stacked.replaceChildren(...(context?.bar ? [quietCopy(context.bar)] : []));
    }
    setHidden(stacked, !source);
    const track = block.querySelector('.up-context-track');
    setHidden(track, pct === null || Boolean(source));
    const fill = track.firstElementChild;
    const width = (pct ?? 0) + '%';
    if (fill.style.width !== width) fill.style.width = width;
    if (fill.classList.contains('up-context-full') !== pct >= 80) fill.classList.toggle('up-context-full');

    const action = block.querySelector('.up-context-action');
    setText(action, context ? (context.compact?.textContent.trim() || text.compact) : text.showRail);
    setHidden(action, Boolean(context) && !context.compact);
    const disabled = Boolean(context?.compact?.disabled);
    if (action.disabled !== disabled) action.disabled = disabled;
  }

  // Sessions ----------------------------------------------------------------

  // Claude shows a session's state in its sidebar row in one of several
  // ways, depending on the version: a .status-dot named by data-kind (in the
  // icon's corner or at the end of the row), data-attention on the title, or
  // a status icon for errors and browsing. Each session row gets
  // data-up-session with that state; widget.css puts a gear in place of the
  // icon of active rows, turning while Claude works, and hides the icon of
  // the others. Rows without an icon, such as side sessions nested under the
  // session that started them, get the gear before their title.
  // data-up-badge names what an active row needs.
  const DOT_KINDS = { running: 'running', clay: 'running', awaiting: 'awaiting', ready: 'ready', unread: 'ready', error: 'error' };
  const ATTENTION = { working: 'running', waiting: 'awaiting', unread: 'ready' };
  const AWAITING_LABEL = /await|input|answer|wartet|eingabe|antwort/i;
  // In the tab-style sidebar rows (Claude 4.23118 and later) the state is a
  // [data-cds="Pulse"] dot colored by the state: muted while working (with
  // .df-tab-dot-running), warning for awaiting, accent for unread.
  const PULSE_COLORS = [['--cds-text-muted', 'running'], ['--cds-fill-warning', 'awaiting'], ['--cds-fill-accent', 'ready']];

  function sessionState(row) {
    const dot = DOT_KINDS[row.querySelector('.status-dot[data-kind]')?.dataset.kind];
    if (dot) return dot;
    const attention = ATTENTION[row.querySelector('[data-attention]')?.dataset.attention];
    if (attention) return attention;
    for (const pulse of row.querySelectorAll('[data-cds="Pulse"]')) {
      if (pulse.classList.contains('df-tab-dot-running')) return 'running';
      const style = pulse.getAttribute('style') ?? '';
      const state = PULSE_COLORS.find(([color]) => style.includes(color))?.[1];
      if (state) return state;
    }
    if (row.querySelector('.df-leading-slot .absolute > [data-cds="Icon"]')) return 'error';
    for (const status of row.querySelectorAll('[role="status"][aria-label]')) {
      const icon = status.querySelector('[data-cds="Icon"]');
      if (!icon) continue;
      if (/animate-pulse/.test(icon.getAttribute('class'))) return 'running';
      return AWAITING_LABEL.test(status.getAttribute('aria-label')) ? 'awaiting' : 'error';
    }
    return null;
  }

  // Some Claude versions (Claude for Windows 4.4212, for one) show when a
  // session works but never mark a finished one as unread. When a session
  // goes from working to idle while it isn't the open one, UI+ marks it
  // Ready itself, until it is opened. Kept in sessionStorage, so it survives
  // reloads but not a Claude restart.
  const READY_KEY = 'usage-pace:inferred-ready';
  const lastState = new Map();
  let inferred;
  try { inferred = new Set(JSON.parse(sessionStorage.getItem(READY_KEY) || '[]')); } catch { inferred = new Set(); }
  function saveInferred() {
    try { sessionStorage.setItem(READY_KEY, JSON.stringify([...inferred])); } catch {}
  }

  function inferReady(main, state) {
    const key = main.closest('[data-row-key]')?.dataset.rowKey;
    if (!key) return state;
    const open = main.getAttribute('aria-current') === 'page' || main.dataset.selected === 'focused';
    const before = lastState.get(key);
    lastState.set(key, state);
    let changed = false;
    if (state || open) {
      // Claude marks it itself, or it's in front of you: nothing to infer.
      changed = inferred.delete(key);
    } else if (before === 'running') {
      inferred.add(key);
      changed = true;
    }
    if (changed) saveInferred();
    return state ?? (inferred.has(key) ? 'ready' : null);
  }

  function setAttribute(node, name, value) {
    if (value === null) node.removeAttribute(name);
    else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function markSessions() {
    const scope = document.querySelector('.dframe-nav-scroll');
    for (const row of document.querySelectorAll('[data-up-session]')) {
      if (!scope?.contains(row)) {
        row.removeAttribute('data-up-session');
        row.removeAttribute('data-up-badge');
      }
    }
    if (!scope) return;
    const badges = strings().badges;
    // Session rows: rows of the sidebar other than its navigation, with an
    // icon or a title in its place.
    for (const main of scope.querySelectorAll('[data-row-main-button]:not([data-row-nav])')) {
      if (!main.querySelector(':scope > :is(.df-leading-slot, [data-row-label="iconless"])')) continue;
      const state = inferReady(main, sessionState(main.closest('[data-row]') ?? main));
      setAttribute(main, 'data-up-session', state ?? 'idle');
      setAttribute(main, 'data-up-badge', badges[state] ?? null);
    }
  }

  // Session colors ----------------------------------------------------------

  // Right-click a session (or its "..." button) and pick a color in Claude's
  // own menu; it shows as a stripe and tint on the row. Saved per session title.
  const COLORS = { red: '#e5484d', orange: '#e0913a', yellow: '#d4b73a', teal: '#2bb5a0', purple: '#8e4ec6', pink: '#d6409f' };
  let sessionColors = {};
  try {
    sessionColors = JSON.parse(stored('colors') || '{}');
  } catch {}
  let menuFor = null;

  // The session id, read from the row's React fiber (this script runs in the
  // page's own world). Without it the title stands in: renaming then drops the
  // color, and two sessions with one title share one.
  const rowTitle = (row) => row.querySelector('[data-row-label]')?.textContent.trim() || null;
  function fiberId(row) {
    const key = Object.keys(row).find((name) => name.startsWith('__reactFiber$'));
    for (let fiber = key ? row[key] : null, depth = 0; fiber && depth < 8; fiber = fiber.return, depth++) {
      const id = fiber.memoizedProps?.conversationUuid;
      if (id) return String(id);
    }
    return null;
  }
  const sessionId = (row) => fiberId(row) || rowTitle(row);

  function applyColors() {
    const scope = document.querySelector('.dframe-nav-scroll');
    if (!scope) return;
    for (const row of scope.querySelectorAll('[data-row]')) {
      const color = sessionColors[sessionId(row)] ?? sessionColors[rowTitle(row)];
      setAttribute(row, 'data-up-color', COLORS[color] ? color : null);
    }
  }

  function setSessionColor(id, color) {
    if (color) sessionColors[id] = color;
    else delete sessionColors[id];
    store('colors', JSON.stringify(sessionColors));
    applyColors();
  }

  // Remember which row a menu is about to open for.
  function noteRow(event) {
    const row = event.target.closest?.('.dframe-nav-scroll [data-row]');
    const id = row && sessionId(row);
    menuFor = id ? { id, at: Date.now() } : null;
  }
  const listen = { capture: true, signal: stop.signal };
  document.addEventListener('contextmenu', noteRow, listen);
  document.addEventListener('pointerdown', (event) => event.target.closest?.('[data-row-action]') && noteRow(event), listen);

  function enhanceMenu() {
    if (!menuFor || Date.now() - menuFor.at > 1500) return;
    // The session menu is the one with a Rename item; its items sit in a scroll container.
    const scroll = document.querySelector('[data-testid="rename-session-trigger"]')?.closest('[data-cds-sheet-scroll]');
    if (!scroll || scroll.hasAttribute('data-up-menu')) return;
    const menu = scroll.closest('[role="menu"]') ?? scroll;
    scroll.setAttribute('data-up-menu', '');
    const { id } = menuFor;
    const current = sessionColors[id];
    const box = element('div', 'up-swatches');
    box.append(element('span', 'up-swatches-label', strings().color));
    const pick = (color) => {
      setSessionColor(id, color);
      for (const target of [document.activeElement, menu]) target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    };
    for (const [name, value] of [['', null], ...Object.entries(COLORS)]) {
      const swatch = element('button', 'up-swatch' + (name === (current ?? '') ? ' up-swatch-on' : ''));
      swatch.type = 'button';
      swatch.title = name || strings().noColor;
      swatch.setAttribute('aria-label', swatch.title);
      if (value) swatch.style.background = value;
      else swatch.classList.add('up-swatch-none');
      swatch.addEventListener('click', (event) => {
        event.stopPropagation();
        pick(name || null);
      });
      box.append(swatch);
    }
    // Before the last separator, which sets Archive and Delete apart.
    const separators = scroll.querySelectorAll(':scope > [role="separator"]');
    const last = separators[separators.length - 1];
    if (last) last.before(last.cloneNode(true), box);
    else scroll.append(box);
  }

  let marking = null;

  function scheduleMarkSessions() {
    marking ??= requestAnimationFrame(() => {
      marking = null;
      if (stopped) return;
      markSessions();
      applyColors();
      enhanceMenu();
    });
  }

  // Data --------------------------------------------------------------------

  // Without usage (signed out, or an account without plan limits) both
  // places drop what they showed.
  function render() {
    if (stopped) return;
    view = buildView(usage, Date.now(), language(), document.documentElement.lang || undefined);
    version += 1;
    if (view) renderSidebar();
    place();
    enhancePopover();
    markSessions();
  }

  async function fetchJson(path) {
    const response = await fetch(path, { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return response.ok ? response.json() : null;
  }

  let organization = null;

  async function usageOf(id) {
    const response = await fetchJson('/api/organizations/' + encodeURIComponent(id) + '/usage');
    return Array.isArray(response?.limits) || response?.five_hour || response?.seven_day ? response : null;
  }

  // The lastActiveOrg cookie names the organization Claude shows, but right
  // after switching accounts it can still name the previous account's, whose
  // usage this account may not read. Then the organization that answered
  // last, and otherwise the first of this account's organizations with plan
  // limits (an API-only organization has none), stands in. Resolves to null
  // when none of them has usage; a network error rejects instead, so the
  // last numbers stay up.
  async function fetchUsage() {
    const tried = new Set();
    for (const id of [cookieOrganization(), organization]) {
      if (!id || tried.has(id)) continue;
      tried.add(id);
      const result = await usageOf(id);
      if (result) {
        organization = id;
        return result;
      }
    }
    const organizations = await fetchJson('/api/organizations');
    for (const { uuid } of Array.isArray(organizations) ? organizations : []) {
      if (!uuid || tried.has(uuid)) continue;
      const result = await usageOf(uuid);
      if (result) {
        organization = uuid;
        return result;
      }
    }
    organization = null;
    return null;
  }

  function cookieOrganization() {
    const value = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/)?.[1];
    return value ? decodeURIComponent(value) : null;
  }

  // One request at a time; a refresh asked for meanwhile runs right after.
  let refreshing = false;
  let refreshAgain = false;

  async function refresh() {
    if (stopped) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    clearTimeout(timer);
    try {
      if (!document.hidden) {
        try {
          usage = await fetchUsage();
        } catch {}
        render();
      }
    } finally {
      refreshing = false;
      if (!stopped) timer = setTimeout(refresh, usage ? POLL_MS : RETRY_MS);
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      }
    }
  }

  function observe(callback, target, options) {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    observers.push(observer);
  }

  // React re-renders the sidebar and mounts the popover on demand. The
  // popover is enhanced before it paints; the sidebar is re-placed shortly after.
  observe(() => {
    enhancePopover();
    scheduleMarkSessions();
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      if (!stopped) place();
    }, 250);
  }, document.body, { childList: true, subtree: true });
  // The rail's context headline and its Compact button change in place.
  observe(enhancePopover, document.body, { subtree: true, characterData: true, attributeFilter: ['data-rail-context-pct', 'disabled'] });
  // A row's state changes in place too.
  observe(scheduleMarkSessions, document.body, { subtree: true, attributeFilter: ['data-kind', 'data-attention', 'aria-label'] });

  // Follow Claude's language setting right away.
  observe(render, document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  document.addEventListener('visibilitychange', () => document.hidden || refresh(), { signal: stop.signal });
  // Switching accounts changes the lastActiveOrg cookie, often without
  // reloading the page.
  let accountCookie = cookieOrganization();
  accountTimer = setInterval(() => {
    const current = cookieOrganization();
    if (current === accountCookie) return;
    accountCookie = current;
    refresh();
  }, ACCOUNT_CHECK_MS);

  // Removes everything this run added to the page and stops its work.
  window.__cdbUsageStatusTeardown = function () {
    stopped = true;
    stop.abort();
    observers.forEach((observer) => observer.disconnect());
    clearTimeout(timer);
    clearTimeout(scheduled);
    clearInterval(accountTimer);
    if (marking !== null) cancelAnimationFrame(marking);
    widget?.remove();
    document.querySelectorAll('.up-context, .up-popover-pace, .up-time, .up-swatches').forEach((node) => node.remove());
    document.querySelectorAll('[data-up-menu]').forEach((node) => node.removeAttribute('data-up-menu'));
    for (const name of ['data-up-session', 'data-up-badge', 'data-up-color']) {
      document.querySelectorAll('[' + name + ']').forEach((node) => node.removeAttribute(name));
    }
    window.__cdbUsageStatusTeardown = null;
  };
  refresh();
})();
