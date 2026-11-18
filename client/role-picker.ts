import { WORKER_ROLES, WORKER_ROLE_IDS, isWorkerRoleId, type WorkerRoleId } from '../shared/sim/cast';
import { CAMPAIGN_PACES, isCampaignPace, type CampaignPace } from '../shared/sim/pace';
import { crewPortrait } from './assets/portraits';

const paceNames = { classic: '经典班', quick: '短班' } as const;
const paceOptions = ['classic', 'quick'] as const;

function duration(seconds: number) {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

export function createRolePicker(app: HTMLElement, roleId: WorkerRoleId, pace: CampaignPace) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'board-toggle role-toggle';
  toggle.dataset.roleToggle = '';
  toggle.setAttribute('aria-controls', 'role-dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '开工设置';
  app.querySelector('.account-tools')!.prepend(toggle);

  const dialog = document.createElement('dialog');
  dialog.className = 'room-dialog role-dialog';
  dialog.id = 'role-dialog';
  dialog.dataset.localRoleDialog = '';
  dialog.setAttribute('aria-labelledby', 'role-dialog-title');
  dialog.innerHTML = `
    <div class="room-dialog-head">
      <h2 id="role-dialog-title">开工设置</h2>
      <button type="button" class="room-dismiss" aria-label="关闭开工设置" data-close-role>×</button>
    </div>
    <form data-local-role-form>
      <fieldset class="setup-field">
        <legend>船员</legend>
        <div class="role-choices">
          ${WORKER_ROLE_IDS.map((role) => `
            <label>
              <input type="radio" name="role" value="${role}" ${role === roleId ? 'checked' : ''}>
              <img src="${crewPortrait(role)}" loading="lazy" alt="">
              <span>${WORKER_ROLES[role].name}</span>
            </label>`).join('')}
        </div>
      </fieldset>
      <fieldset class="setup-field">
        <legend>班次</legend>
        <div class="pace-choices">
          ${paceOptions.map((key) => `
            <label>
              <input type="radio" name="pace" value="${key}" ${key === pace ? 'checked' : ''}>
              <b>${paceNames[key]}</b>
              <small>白天 ${duration(CAMPAIGN_PACES[key].daySeconds)} · 夜晚 ${duration(CAMPAIGN_PACES[key].nightSeconds)}</small>
            </label>`).join('')}
        </div>
      </fieldset>
      <p>更换船员或班次后会重新开工。</p>
      <button class="room-create setup-confirm" type="submit">按设置开工</button>
    </form>
  `;
  app.append(dialog);
  const form = dialog.querySelector<HTMLFormElement>('form')!;

  toggle.addEventListener('click', () => {
    if (dialog.open) return;
    form.reset();
    app.dispatchEvent(new Event('fatfish:room-open'));
    dialog.showModal();
    toggle.setAttribute('aria-expanded', 'true');
  });
  dialog.querySelector('[data-close-role]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => toggle.setAttribute('aria-expanded', 'false'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selection = new FormData(form);
    const role = selection.get('role');
    const nextPace = selection.get('pace');
    if (!isWorkerRoleId(role) || !isCampaignPace(nextPace) || (role === roleId && nextPace === pace)) {
      dialog.close();
      return;
    }
    const url = new URL(location.href);
    if (role !== roleId) url.searchParams.set('role', role);
    if (nextPace === 'quick') url.searchParams.set('pace', nextPace);
    else url.searchParams.delete('pace');
    location.assign(url);
  });

  return { setVisible: (visible: boolean) => { toggle.hidden = !visible; } };
}
