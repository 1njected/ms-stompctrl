/* Work-in-progress notice, shown until it is accepted.

   This writes to the pedal's flash memory, so the risk is real rather than
   boilerplate: say what it is and let the user decide before anything is
   connected. The notice therefore loads first and blocks the page.

   Acceptance is kept in localStorage rather than a cookie. There is no server
   here -- the page is static and the pedal is reached from the browser -- so a
   cookie would be sent nowhere, would be capped at 4 KB, and would be the only
   cookie the app has. localStorage is what the rest of the app already uses.

   A storage failure shows the notice again rather than swallowing it: being
   asked twice is a smaller harm than silently skipping the warning. */
(function (g) {
  if (typeof document === 'undefined') return;

  // Bumping this re-asks everyone, which is the point if the terms change.
  const KEY = 'stomp.riskAccepted.v1';

  const accepted = () => {
    try { return localStorage.getItem(KEY) !== null; } catch { return false; }
  };

  function remember() {
    try { localStorage.setItem(KEY, new Date().toISOString()); }
    catch (e) { g.log?.('disclaimer_persist_failed', String(e)); }
  }

  g.riskNotice = {
    accepted,
    // So it can be re-read deliberately, and so tests and support have a way back.
    reset() { try { localStorage.removeItem(KEY); } catch {} }
  };

  if (accepted()) return;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  /* A real <dialog> rather than a div: showModal() makes the rest of the
     document inert and manages focus, which a hand-rolled overlay does not --
     a focusin guard let a keyboard user tab straight into the page behind. */
  const panel = el('dialog', 'risk-panel');
  panel.setAttribute('aria-labelledby', 'risk-title');

  const title = el('h2', null, 'Work in progress');
  title.id = 'risk-title';

  const lead = el('p', 'risk-lead',
    'MS StompCtrl is unfinished software that writes to your pedal’s memory. '
    + 'Use it at your own risk.');

  const list = el('ul', 'risk-points');
  for (const point of [
    'Editing and restoring write to the pedal’s flash. A failed write can leave a patch or an effect in a state you have to fix by hand.',
    'Back up your patches before changing anything, and keep the file somewhere else.',
    'This is unofficial. It is not affiliated with, endorsed by, or supported by ZOOM Corporation, and it comes with no warranty.'
  ]) list.append(el('li', null, point));

  const foot = el('div', 'risk-foot');
  const accept = el('button', 'primary', 'I understand — continue');
  accept.type = 'button';
  foot.append(accept);

  panel.append(title, lead, list, foot);

  // Escape would otherwise dismiss it without a decision.
  panel.addEventListener('cancel', e => e.preventDefault());

  const show = () => {
    document.body.append(panel);
    document.body.classList.add('risk-locked');
    panel.showModal();
    accept.focus();
  };

  accept.onclick = () => {
    remember();
    panel.close();
    panel.remove();
    document.body.classList.remove('risk-locked');
    g.log?.('risk_accepted', true);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show);
  else show();
})(globalThis);
