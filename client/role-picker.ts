import { WORKER_ROLES, WORKER_ROLE_IDS, type WorkerRoleId } from '../shared/sim/cast';
import { crewPortrait } from './assets/portraits';

export function createRolePicker(app: HTMLElement, roleId: WorkerRoleId) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'board-toggle role-toggle';
  toggle.dataset.roleToggle = '';
  toggle.setAttribute('aria-controls', 'role-dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '选角色';
  app.querySelector('.account-tools')!.prepend(toggle);

  const dialog = document.createElement('dialog');
  dialog.className = 'room-dialog role-dialog';
  dialog.id = 'role-dialog';
  dialog.dataset.localRoleDialog = '';
  dialog.setAttribute('aria-labelledby', 'role-dialog-title');
  dialog.innerHTML = `
    <div class="room-dialog-head">
      <h2 id="role-dialog-title">选个工位上岛</h2>
      <button type="button" class="room-dismiss" aria-label="关闭角色选择" data-close-role>×</button>
    </div>
    <form data-local-role-form>
      <div class="role-choices">
        ${WORKER_ROLE_IDS.map((role) => `
          <label>
            <input type="radio" name="role" value="${role}" ${role === roleId ? 'checked' : ''}>
            <img src="${crewPortrait(role)}" loading="lazy" alt="">
            <span>${WORKER_ROLES[role].name}</span>
          </label>`).join('')}
      </div>
      <p>更换角色会从当前日期重新开工。</p>
      <button class="room-create" type="submit">选好了</button>
    </form>
  `;
  app.append(dialog);

  toggle.addEventListener('click', () => {
    if (dialog.open) return;
    app.dispatchEvent(new Event('fatfish:room-open'));
    dialog.showModal();
    toggle.setAttribute('aria-expanded', 'true');
  });
  dialog.querySelector('[data-close-role]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => toggle.setAttribute('aria-expanded', 'false'));
  dialog.querySelector('form')!.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = new FormData(event.currentTarget as HTMLFormElement).get('role');
    if (selected === roleId || typeof selected !== 'string') {
      dialog.close();
      return;
    }
    const url = new URL(location.href);
    url.searchParams.set('role', selected);
    location.assign(url);
  });

  return { setVisible: (visible: boolean) => { toggle.hidden = !visible; } };
}
