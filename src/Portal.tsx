import { useEffect, useState } from 'react';
import { ArrowRight, Building2, Check, Copy, Eye, Layers3, LogOut, MapPin, Plus, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { api, type OrganizationMember, type OrganizationSummary, type SpaceSummary } from './api';
import './portal.css';

type Account = { id: string; email: string; name: string; organization: string };
const viewsLabel = (value: number) => {
  const part = new Intl.PluralRules('ru-RU').select(value);
  return `${value} ${part === 'one' ? 'просмотр' : part === 'few' ? 'просмотра' : 'просмотров'}`;
};
const roleLabel: Record<string, string> = { owner: 'Владелец', admin: 'Администратор', editor: 'Редактор', viewer: 'Просмотр' };

export default function Portal() {
  const mode = location.pathname === '/' ? 'home' : location.pathname === '/register' ? 'register' : location.pathname === '/login' ? 'login' : 'account';
  const [user, setUser] = useState<Account | null>(null);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [name, setName] = useState('');
  const [organization, setOrganization] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'published'>('all');
  const [copied, setCopied] = useState('');
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState('');
  const [membersReload, setMembersReload] = useState(0);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [inviteUrl, setInviteUrl] = useState('');

  const load = async () => {
    try {
      const data = await api.account();
      setUser(data.user);
      setSpaces(data.spaces);
      setOrganizations(data.organizations);
      const params = new URLSearchParams(location.search);
      const inviteToken = params.get('invite');
      if (inviteToken) {
        await api.acceptInvite(inviteToken);
        params.delete('invite');
        history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
        const refreshed = await api.account();
        setOrganizations(refreshed.organizations);
        setSpaces(refreshed.spaces);
        setError('Приглашение принято. Команда подключена к вашему аккаунту.');
      }
      const selected = data.organizations.find((org) => org.id === organizationId) ?? data.organizations[0];
      if (selected) setOrganizationId(selected.id);
    } catch (err) {
      setUser(null);
      if (mode === 'account' && err instanceof Error) setError('Войдите или создайте аккаунт, чтобы управлять своими картами.');
    }
  };
  useEffect(() => { void load(); }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'register') await api.register(name, email, password, organization);
      else await api.login(password, 'account', email);
      const invite = new URLSearchParams(location.search).get('invite');
      location.assign(`/account${invite ? `?invite=${encodeURIComponent(invite)}` : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выполнить вход.');
    } finally {
      setBusy(false);
    }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const project = await api.createSpace(title, organizationId || undefined);
      location.assign(`/editor/${project.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать карту.');
      setBusy(false);
    }
  };
  const logout = async () => {
    await api.logout('account');
    location.assign('/');
  };

  const filteredSpaces = spaces.filter((space) => {
    if (space.organizationId !== organizationId) return false;
    const matchesText = space.title.toLocaleLowerCase('ru-RU').includes(search.trim().toLocaleLowerCase('ru-RU'));
    const matchesFilter = filter === 'all' || (filter === 'published' ? space.isPublic : !space.isPublic);
    return matchesText && matchesFilter;
  });
  const organizationSpaces = spaces.filter((space) => space.organizationId === organizationId);
  const selectedOrganization = organizations.find((org) => org.id === organizationId);
  const canCreateSpace = ['owner', 'admin', 'editor'].includes(selectedOrganization?.role ?? '');
  const copyLink = async (slug: string) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/map/${slug}`);
      setCopied(slug);
      window.setTimeout(() => setCopied(''), 2200);
    } catch {
      setError('Не удалось скопировать ссылку. Откройте опубликованную карту и скопируйте адрес из браузера.');
    }
  };
  useEffect(() => {
    if (!organizationId || !user) return;
    let active = true;
    setMembers([]);
    setMembersError('');
    setMembersLoading(true);
    void api.teamMembers(organizationId)
      .then((data) => { if (active) setMembers(data.members); })
      .catch(() => { if (active) { setMembers([]); setMembersError('Не удалось загрузить список участников. Проверьте соединение и повторите попытку.'); } })
      .finally(() => { if (active) setMembersLoading(false); });
    return () => { active = false; };
  }, [organizationId, user?.id, membersReload]);
  const sendInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!organizationId) return;
    setBusy(true); setError(''); setInviteUrl('');
    try {
      const invite = await api.inviteMember(organizationId, inviteEmail, inviteRole);
      setInviteUrl(`${location.origin}/register?invite=${encodeURIComponent(invite.token)}`);
      setInviteEmail('');
      setMembers((await api.teamMembers(organizationId)).members);
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось создать приглашение.'); }
    finally { setBusy(false); }
  };
  const changeRole = async (member: OrganizationMember, role: string) => {
    if (!organizationId) return;
    try { setMembers((await api.updateMemberRole(organizationId, member.id, role)).members); }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось изменить роль.'); }
  };
  const removeMember = async (member: OrganizationMember) => {
    if (!organizationId) return;
    try { await api.removeMember(organizationId, member.id); setMembers((await api.teamMembers(organizationId)).members); }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось удалить участника.'); }
  };

  if (!user && mode === 'home') return (
    <main className="portal-shell portal-home">
      <header className="landing-nav"><a className="portal-brand" href="/"><span><Layers3 /></span> Пространство</a><nav><a href="#возможности">Возможности</a><a href="/map/demo">Демо ТТК</a></nav><div><a className="landing-login" href="/login">Войти</a><a className="portal-primary" href="/register">Создать карту <ArrowRight size={16}/></a></div></header>
      <section className="landing-hero">
        <div className="landing-copy"><div className="portal-eyebrow"><span className="landing-live-dot"/> ЦИФРОВЫЕ КАРТЫ ДЛЯ БИЗНЕСА И ЛЮДЕЙ</div><h1>Покажите людям,<br/><em>куда идти.</em></h1><p>Интерактивная карта вашего пространства: этажи, места, панорамы и маршруты — собраны в одной ссылке.</p><div className="landing-actions"><a className="portal-primary" href="/register">Создать пространство <ArrowRight size={17}/></a><a className="landing-secondary" href="/map/demo">Сначала посмотреть демо <span>↗</span></a></div><div className="landing-proof"><span><ShieldCheck size={16}/> Вы управляете публикацией</span><span><Building2 size={16}/> Офис · площадка · кампус</span></div></div>
        <div className="landing-product"><div className="landing-product-top"><div><span className="landing-window-dots"><i/><i/><i/></span><strong>Живая карта пространства</strong></div><span className="landing-demo-pill">ДЕМО ТТК</span></div><div className="landing-map-frame"><iframe title="Интерактивная демо-карта ТрансТелеКома" src="/embed/demo" loading="lazy"/></div><div className="landing-product-foot"><span><i/> Карта доступна по ссылке</span><a href="/map/demo">Открыть полностью <ArrowRight size={14}/></a></div></div>
      </section>
      <section className="landing-capabilities" id="возможности"><div className="landing-capabilities-heading"><span>ОДНО ПРОСТРАНСТВО — ВЕСЬ ОПЫТ ПОСЕТИТЕЛЯ</span><h2>От плана до понятного маршрута</h2><p>Соберите пространство один раз. Для посетителя это станет простой картой с местами, этажами и понятным путём.</p></div><div className="landing-feature-grid"><article><b>01 / ПЛАН</b><h3>Соберите карту</h3><p>Добавьте этажи, помещения, входы и важные точки в визуальном редакторе.</p></article><article><b>02 / ОБЗОР</b><h3>Покажите место</h3><p>Привяжите панорамы, сшейте кадры и помогите посетителю сориентироваться.</p></article><article><b>03 / ПУБЛИКАЦИЯ</b><h3>Поделитесь ссылкой</h3><p>Проверьте карту в черновике и опубликуйте, когда всё готово.</p></article></div></section>
      <footer className="landing-footer"><a className="portal-brand" href="/"><span><Layers3/></span> Пространство</a><span>Инструмент для понятной навигации внутри и вокруг зданий</span><a href="/map/demo">Демонстрационный объект ТТК</a></footer>
    </main>
  );

  if (!user) return (
    <main className="portal-shell portal-auth">
      <a className="portal-brand" href="/"><span><Layers3 /></span> Карта пространства</a>
      <section className="portal-auth-card">
        <div className="portal-eyebrow"><Sparkles size={14} /> КАРТЫ ВАШИХ ПРОСТРАНСТВ</div>
        <h1>{mode === 'register' ? 'Создайте свой аккаунт' : 'С возвращением'}</h1>
        <p>Собирайте понятные карты зданий, площадок и любых мест, которыми хотите поделиться.</p>
        <form onSubmit={submit}>
          {mode === 'register' && <label>Ваше имя<input autoComplete="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Алексей" /></label>}
          {mode === 'register' && <label>Компания или команда <span className="portal-optional">необязательно</span><input autoComplete="organization" maxLength={160} value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="Например, БЦ «Север»" /></label>}
          <label>Электронная почта<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label>
          <label>Пароль<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={mode === 'register' ? 12 : 1} maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'register' ? 'Не менее 12 символов' : 'Ваш пароль'} /></label>
          {error && <div className="portal-error" role="alert">{error}</div>}
          <button className="portal-primary" disabled={busy}>{busy ? 'Подождите…' : mode === 'register' ? 'Создать аккаунт' : 'Войти'} <ArrowRight size={17} /></button>
        </form>
        <div className="portal-auth-switch">{mode === 'register' ? <>Уже есть аккаунт? <a href={`/login${new URLSearchParams(location.search).has('invite') ? `?invite=${encodeURIComponent(new URLSearchParams(location.search).get('invite')!)}` : ''}`}>Войти</a></> : <>Впервые здесь? <a href={`/register${new URLSearchParams(location.search).has('invite') ? `?invite=${encodeURIComponent(new URLSearchParams(location.search).get('invite')!)}` : ''}`}>Создать аккаунт</a></>}</div>
        <a className="portal-demo-link" href="/map/demo">Посмотреть демо-карту ТТК</a>
      </section>
      <div className="portal-footnote">Ваши карты по умолчанию приватны. Вы сами решаете, когда публиковать ссылку.</div>
    </main>
  );

  return (
    <main className="portal-shell">
      <header className="portal-topbar"><a className="portal-brand" href="/"><span><Layers3 /></span> Карта пространства</a><div><span className="portal-user">{user.name}</span><button className="portal-logout" onClick={() => void logout()}><LogOut size={16} /> Выйти</button></div></header>
      <section className="portal-welcome"><div><div className="portal-eyebrow">КОМАНДНОЕ ПРОСТРАНСТВО</div><h1>Добро пожаловать, {user.name.split(' ')[0]}</h1><p>Создавайте карты вместе, управляйте доступом и делитесь публикациями с посетителями.</p></div><div className="portal-mark"><Building2 size={25} /></div></section>
      {organizations.length > 0 && <div className="portal-org-switch"><label>Рабочая команда<select value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>{organizations.map((org) => <option key={org.id} value={org.id}>{org.name} · {org.role === 'owner' ? 'владелец' : org.role === 'admin' ? 'администратор' : org.role === 'editor' ? 'редактор' : 'просмотр'}</option>)}</select></label></div>}
      <section className="portal-stats" aria-label={`Сводка команды: ${selectedOrganization?.name ?? 'пространства'}`}><div><span>Карт в команде</span><strong>{organizationSpaces.length}</strong></div><div><span>Опубликовано</span><strong>{organizationSpaces.filter((space) => space.isPublic).length}</strong></div><div><span>Просмотры</span><strong>{organizationSpaces.reduce((sum, space) => sum + space.views, 0).toLocaleString('ru-RU')}</strong></div></section>
      {error && <div className="portal-error" role="alert">{error}</div>}
      {canCreateSpace ? <form className="portal-create" onSubmit={create}><div><strong>Создайте новое пространство</strong><span>Начните с названия. План, этажи и панорамы добавите в редакторе.</span></div><label className="sr-only" htmlFor="new-space-title">Название пространства</label><input id="new-space-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, Бизнес-центр «Север»"/><button className="portal-primary" disabled={busy || !title.trim()}><Plus size={17} /> Новая карта</button></form> : <div className="portal-create portal-create-readonly" role="status"><div><strong>Режим просмотра</strong><span>У вас есть доступ к картам этой команды. Чтобы создать или изменить карту, попросите владельца выдать роль редактора.</span></div></div>}
      <div className="portal-list-head"><div><h2>Пространства команды <span>{organizationSpaces.length}</span></h2><p>Карты команды «{selectedOrganization?.name ?? ''}».</p></div><div className="portal-filters"><label className="portal-search"><Search size={15}/><input aria-label="Поиск по картам" placeholder="Найти пространство" value={search} onChange={(e) => setSearch(e.target.value)}/></label><select aria-label="Фильтр карт" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}><option value="all">Все карты</option><option value="draft">Черновики</option><option value="published">Опубликованные</option></select></div></div>
      {filteredSpaces.length ? <div className="portal-space-grid">{filteredSpaces.map((space) => <article className="portal-space-card" key={space.slug}><div className="portal-card-top"><div className="portal-space-icon"><Layers3 size={20} /></div><span className={`portal-space-state ${space.isPublic ? 'published' : 'draft'}`}><i />{space.isPublic ? 'Опубликована' : 'Черновик'}</span></div><h3>{space.title}</h3><div className="portal-space-meta">Обновлена {new Date(space.updatedAt * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })} · v{space.revision} · {space.role === 'owner' ? 'владелец' : space.role === 'admin' ? 'администратор' : space.role === 'editor' ? 'редактор' : 'просмотр'}{space.isPublic && space.publishedRevision !== space.revision && <span className="portal-stale">Есть неопубликованные изменения</span>}</div><div className="portal-space-metrics"><span><Eye size={15} /> {viewsLabel(space.views)}</span><span>{space.isPublic ? `Публикация v${space.publishedRevision}` : 'Видна только команде'}</span></div><div className="portal-space-actions"><a className={space.role === 'viewer' ? 'portal-secondary' : 'portal-primary'} href={`/editor/${space.slug}`}>{space.role === 'viewer' ? 'Просмотреть черновик' : 'Открыть редактор'} <ArrowRight size={15} /></a>{space.isPublic && <><a className="portal-secondary" href={`/map/${space.slug}`} target="_blank" rel="noreferrer">Открыть карту</a><button className="portal-copy" onClick={() => void copyLink(space.slug)} aria-label="Скопировать ссылку на карту">{copied === space.slug ? <Check size={16}/> : <Copy size={16}/>}</button></>}</div></article>)}</div> : organizationSpaces.length ? <section className="portal-empty portal-empty-small"><div><Search size={21}/></div><h2>Ничего не найдено</h2><p>Измените запрос или фильтр. Пространства не удалены.</p></section> : <section className="portal-empty"><div><MapPin size={23} /></div><h2>{canCreateSpace ? 'Начните с первого пространства' : 'В этой команде пока нет карт'}</h2><p>{canCreateSpace ? 'Создайте карту выше. Она будет приватной, пока вы сами не опубликуете её.' : 'Попросите владельца или редактора команды создать первую карту.'}</p></section>}
      {organizationId && <section className="portal-team"><div className="portal-team-heading"><div><div className="portal-eyebrow">СОВМЕСТНАЯ РАБОТА</div><h2>Команда и доступ</h2><p>Участники видят карты этой команды. Роль определяет, что они могут делать.</p></div><span>{membersLoading ? '\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430\u2026' : membersError ? '\u0421\u043f\u0438\u0441\u043e\u043a \u043d\u0435 \u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d' : members.length} {members.length === 1 ? 'участник' : 'участника'}</span></div>{membersError && <div className="portal-member-error" role="alert"><span>{membersError}</span><button className="portal-secondary" onClick={() => setMembersReload((attempt) => attempt + 1)}>{'\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u044c'}</button></div>}{membersLoading && <p className="portal-member-state" role="status">{'\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043c \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u043e\u0432\u2026'}</p>}<div className="portal-member-list" aria-busy={membersLoading}>{members.map((member) => <div className="portal-member" key={member.id}><div className="portal-member-avatar">{member.name.trim().slice(0,1).toLocaleUpperCase('ru-RU')}</div><div className="portal-member-id"><strong>{member.name}{member.id === user.id ? ' · вы' : ''}</strong><span>{member.email}</span></div>{member.role === 'owner' || organizations.find(o=>o.id===organizationId)?.role === 'viewer' || organizations.find(o=>o.id===organizationId)?.role === 'editor' ? <span className="portal-role-label">{roleLabel[member.role] ?? member.role}</span> : <><select aria-label={`Роль: ${member.name}`} value={member.role} onChange={(e)=>void changeRole(member,e.target.value)} disabled={member.role==='admin'&&organizations.find(o=>o.id===organizationId)?.role!=='owner'}><option value="admin">Администратор</option><option value="editor">Редактор</option><option value="viewer">Просмотр</option></select>{member.id !== user.id && <button className="portal-remove-member" onClick={()=>void removeMember(member)}>Удалить</button>}</>}</div>)}</div>{['owner','admin'].includes(organizations.find(o=>o.id===organizationId)?.role??'') && <form className="portal-invite" onSubmit={sendInvite}><label>Email участника<input type="email" required maxLength={254} value={inviteEmail} onChange={(e)=>setInviteEmail(e.target.value)} placeholder="colleague@company.ru"/></label><label>Доступ<select value={inviteRole} onChange={(e)=>setInviteRole(e.target.value as 'editor'|'viewer')}><option value="editor">Редактор — менять карту</option><option value="viewer">Просмотр — читать черновик команды</option></select></label><button className="portal-primary" disabled={busy||!inviteEmail}>Создать ссылку-приглашение</button></form>}{inviteUrl && <div className="portal-invite-link"><strong>Ссылка действует 7 дней и привязана к указанному email</strong><div><input readOnly value={inviteUrl}/><button className="portal-secondary" onClick={()=>void navigator.clipboard.writeText(inviteUrl)}>Скопировать</button></div></div>}<p className="portal-team-note">Приглашение принимает аккаунт с совпадающим адресом; подтверждения почты пока нет, поэтому передавайте ссылку лично. Отправка почты не настроена.</p></section>}
      <footer className="portal-footer"><a href="/map/demo">Посмотреть демонстрацию</a><span>Редактор · просмотр · публикация по вашей ссылке</span></footer>
    </main>
  );
}
