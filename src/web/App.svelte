<script lang="ts">
	import { onMount } from "svelte";
	import { href, router, type RouteName } from "./router.svelte.ts";
	import CreateOrg from "./screens/CreateOrg.svelte";
	import Join from "./screens/Join.svelte";
	import MemberScreen from "./screens/Member.svelte";
	import Settings from "./screens/Settings.svelte";
	import Setup from "./screens/Setup.svelte";
	import TaskDetail from "./screens/TaskDetail.svelte";
	import TaskList from "./screens/TaskList.svelte";
	import TaskNew from "./screens/TaskNew.svelte";
	import TeamScreen from "./screens/Team.svelte";
	import Today from "./screens/Today.svelte";
	import Welcome from "./screens/Welcome.svelte";
	import { loadSession, session } from "./session.svelte.ts";
	import { setupStatus } from "./setup.svelte.ts";
	import { liveMember, startSync, stopSync } from "./sync.svelte.ts";
	import Avatar from "./components/Avatar.svelte";
	import Icon, { type IconName } from "./components/Icon.svelte";

	const nav: { route: RouteName; label: string; icon: IconName }[] = [
		{ route: "today", label: "Today", icon: "today" },
		{ route: "tasks", label: "Tasks", icon: "tasks" },
		{ route: "settings", label: "Settings", icon: "settings" },
	];

	// Pages opened from a one-time link work whether or not this device is signed in.
	const linkPages: RouteName[] = ["join", "code", "create", "recover"];
	const isLinkPage = $derived(linkPages.includes(router.route.name));
	const sectionOf: Partial<Record<RouteName, RouteName>> = {
		setup: "settings",
		member: "settings",
		team: "settings",
		task: "tasks",
		"new-task": "tasks",
	};
	const current = $derived(sectionOf[router.route.name] ?? router.route.name);

	onMount(loadSession);

	const signedIn = $derived(session.current.status === "signedIn" ? session.current.me : null);
	// A dot on your initials when this phone needs setting up for reminders.
	const phoneStatus = $derived(signedIn ? setupStatus(signedIn) : "ok");
	// New task is one tap away from the two main screens.
	const showFab = $derived(
		signedIn !== null && (router.route.name === "today" || router.route.name === "tasks"),
	);

	// Simple view (FR-34): follows the live member, so an admin's change applies at once.
	const simple = $derived(
		session.current.status === "signedIn" &&
			(liveMember(session.current.me.member.id)?.simpleView ??
				session.current.me.member.simpleView),
	);
	$effect(() => {
		document.documentElement.classList.toggle("simple", simple);
	});

	// Live data runs while signed in (FR-50).
	$effect(() => {
		if (session.current.status === "signedIn") startSync();
		else if (session.current.status === "signedOut") stopSync();
	});
</script>

<header>
	<div class="bar">
		<a class="brand" href={href("today")}>
			<img src="/icon-192.png" alt="" width="32" height="32" />
			<span>
				<span class="name">Kinnect</span>
				{#if signedIn}<span class="family">{signedIn.organization.name}</span>{/if}
			</span>
		</a>
		{#if signedIn && !simple}
			<a
				class="me"
				href={href(phoneStatus === "ok" ? "settings" : "setup")}
				aria-label={phoneStatus === "ok" ? "Your settings" : "Set up this phone for reminders"}
			>
				<Avatar id={signedIn.member.id} name={signedIn.member.displayName} size={36} />
				{#if phoneStatus !== "ok"}<span class="dot-badge {phoneStatus}"></span>{/if}
			</a>
		{/if}
	</div>
</header>

<main class:with-nav={signedIn && !isLinkPage && !simple}>
	{#if router.route.name === "create"}
		<CreateOrg link={router.route.params[0] ?? ""} />
	{:else if router.route.name === "join"}
		<Join mode="link" orgId={router.route.params[0] ?? ""} token={router.route.params[1] ?? ""} />
	{:else if router.route.name === "code"}
		<Join mode="code" />
	{:else if router.route.name === "recover"}
		<Join mode="recover" token={router.route.params[0] ?? ""} />
	{:else if session.current.status === "loading"}
		<p class="muted">Loading…</p>
	{:else if session.current.status === "error"}
		<div class="card">
			<p class="error">{session.current.message}</p>
			<button onclick={loadSession}>Try again</button>
		</div>
	{:else if session.current.status === "signedOut"}
		<Welcome />
	{:else if router.route.name === "setup"}
		<Setup me={session.current.me} />
	{:else if simple && router.route.name !== "task"}
		<Today me={session.current.me} simple />
	{:else if router.route.name === "tasks"}
		<TaskList me={session.current.me} />
	{:else if router.route.name === "task"}
		<TaskDetail me={session.current.me} taskId={router.route.params[0] ?? ""} {simple} />
	{:else if router.route.name === "new-task"}
		<TaskNew me={session.current.me} teamId={router.route.params[0] ?? ""} />
	{:else if router.route.name === "settings"}
		<Settings me={session.current.me} />
	{:else if router.route.name === "member"}
		<MemberScreen me={session.current.me} memberId={router.route.params[0] ?? ""} />
	{:else if router.route.name === "team"}
		<TeamScreen me={session.current.me} teamId={router.route.params[0] ?? ""} />
	{:else}
		<Today me={session.current.me} />
	{/if}
</main>

{#if showFab && !simple}
	<a class="fab" href={href("new-task")} aria-label="New task"
		><Icon name="plus" size={28} stroke={2.4} /></a
	>
{/if}

{#if signedIn && !isLinkPage && !simple}
	<nav aria-label="Main">
		{#each nav as item (item.route)}
			<a href={href(item.route)} aria-current={current === item.route ? "page" : undefined}>
				<span class="pill"><Icon name={item.icon} size={22} /></span>
				{item.label}
			</a>
		{/each}
	</nav>
{/if}

<style>
	header {
		background: var(--header);
		color: #fff;
		padding-top: env(safe-area-inset-top);
	}
	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		max-width: 720px;
		margin: 0 auto;
		padding: 10px var(--space);
		min-height: 60px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		color: #fff;
		min-width: 0;
	}
	.brand img {
		border-radius: 9px;
		box-shadow: 0 0 0 2px rgb(255 255 255 / 0.25);
	}
	.brand > span {
		display: flex;
		flex-direction: column;
		line-height: 1.15;
		min-width: 0;
	}
	.name {
		font-size: 1.15rem;
		font-weight: 750;
		letter-spacing: -0.01em;
	}
	.family {
		font-size: 0.82rem;
		font-weight: 500;
		opacity: 0.85;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.me {
		position: relative;
		display: flex;
		border-radius: 50%;
		box-shadow: 0 0 0 2px rgb(255 255 255 / 0.35);
	}
	/* Bright on the header band in both themes: red when reminders can't arrive, amber for steps left. */
	.dot-badge {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 13px;
		height: 13px;
		border-radius: 50%;
		border: 2px solid var(--header);
		background: #fbbf24;
	}
	.dot-badge.broken {
		background: #f87171;
	}
	main {
		flex: 1;
		width: 100%;
		max-width: 720px;
		margin: 0 auto;
		padding: var(--space) var(--space) calc(var(--space) * 2);
	}
	main.with-nav {
		padding-bottom: calc(var(--nav-height) + 96px + env(safe-area-inset-bottom));
	}
	nav {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 10;
		display: flex;
		justify-content: center;
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		backdrop-filter: blur(12px);
		border-top: 1px solid var(--border);
		padding-bottom: env(safe-area-inset-bottom);
	}
	nav a {
		flex: 1;
		max-width: 200px;
		height: var(--nav-height);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		color: var(--muted);
		font-size: 0.75rem;
		font-weight: 600;
	}
	.pill {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 56px;
		height: 30px;
		border-radius: 999px;
		transition: background-color 0.2s ease;
	}
	nav a[aria-current="page"] {
		color: var(--text);
	}
	nav a[aria-current="page"] .pill {
		background: var(--accent-soft);
		color: var(--on-accent-soft);
	}
	.fab {
		position: fixed;
		z-index: 10;
		right: max(var(--space), calc(50vw - 360px + var(--space)));
		bottom: calc(var(--nav-height) + 16px + env(safe-area-inset-bottom));
		width: 60px;
		height: 60px;
		border-radius: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--accent);
		color: var(--on-accent);
		box-shadow: var(--shadow-raised);
	}
	.fab:active {
		transform: scale(0.95);
	}
</style>
