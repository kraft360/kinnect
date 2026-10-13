<script lang="ts">
	import type { TaskState } from "../../shared/sync.ts";
	import type { MeResponse } from "../../shared/types.ts";
	import { api, errorMessage } from "../api.ts";
	import { href } from "../router.svelte.ts";
	import { loadSession } from "../session.svelte.ts";
	import Icon from "../components/Icon.svelte";
	import TaskRow from "../components/TaskRow.svelte";
	import { setupStatus } from "../setup.svelte.ts";
	import { isPending, live, send, todayItems, type TodayItem } from "../sync.svelte.ts";
	import OccurrenceCard from "./OccurrenceCard.svelte";
	import OfflineBanner from "./OfflineBanner.svelte";

	// Home screen (FR-30); in simple view the only screen (FR-34).
	let { me, simple = false }: { me: MeResponse; simple?: boolean } = $props();

	// Re-evaluated every minute so items move from "later" to "now".
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});

	const meId = $derived(me.member.id);
	const timeZone = $derived(me.organization.timezone);
	// Simple view shows only what the member is expected to do themselves.
	const forMe = (item: TodayItem) =>
		!simple || item.task.assigneeId === null || item.task.assigneeId === meId;
	const items = $derived(todayItems(meId, timeZone, now).filter(forMe));
	const dueNow = $derived(
		items.filter((i) => isPending(i.occurrence) && i.occurrence.dueAt <= now),
	);
	const later = $derived(items.filter((i) => isPending(i.occurrence) && i.occurrence.dueAt > now));
	// The next item gets a full card (all of them in simple view); the rest are compact rows.
	const featured = $derived(simple ? later : dueNow.length ? [] : later.slice(0, 1));
	const rest = $derived(later.slice(featured.length));
	const done = $derived(items.filter((i) => !isPending(i.occurrence)));
	// Open plain tasks assigned to me, so Today is useful without schedules.
	const todos = $derived(
		Object.values(live.tasks)
			.filter((t) => !t.archived && !t.schedule && t.doneAt === null && t.assigneeId === meId)
			.sort((a, b) => a.createdAt - b.createdAt),
	);
	const disabled = $derived(live.status !== "live");
	let error = $state("");
	// Today is only what needs doing; setup lives on its own screen, except when reminders can't arrive at all (FR-42).
	const broken = $derived(setupStatus(me) === "broken");

	const dateLine = $derived(
		new Date(now).toLocaleDateString(undefined, {
			weekday: "long",
			day: "numeric",
			month: "long",
			timeZone,
		}),
	);
	const greeting = $derived.by(() => {
		const hour = Number(
			new Date(now).toLocaleString("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }),
		);
		return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
	});
	const firstName = $derived(me.member.displayName.split(/\s+/)[0]);

	const markDone = (task: TaskState) =>
		send({ type: "task.done", id: task.id }, (tasks) => {
			if (tasks[task.id]) Object.assign(tasks[task.id], { doneAt: Date.now(), doneBy: meId });
		});

	async function fullView() {
		if (!confirm("Switch to the full app with all tasks and settings?")) return;
		try {
			await api("PATCH", "/api/me", { simpleView: false });
			await loadSession();
		} catch (e) {
			error = errorMessage(e);
		}
	}
</script>

<OfflineBanner />

<div class="hello">
	<p class="date">{dateLine}</p>
	<h2>{greeting}, {firstName}</h2>
	{#if live.syncedVersion !== null && (dueNow.length || later.length || todos.length)}
		<p class="muted summary">
			{[
				dueNow.length ? `${dueNow.length} to do now` : "",
				later.length ? `${later.length} later today` : "",
				todos.length ? `${todos.length} to-do${todos.length > 1 ? "s" : ""}` : "",
			]
				.filter(Boolean)
				.join(" · ")}
		</p>
	{/if}
</div>

{#if broken}
	<a class="callout danger broken" href={href("setup")}>
		<Icon name="bell-off" />
		<span class="body"><strong>Reminders aren't reaching this phone</strong></span>
		<span class="fix">Fix<Icon name="chevron" size={18} /></span>
	</a>
{/if}

{#if live.syncedVersion === null}
	<p class="muted">Loading…</p>
{:else if !items.length && !todos.length}
	<div class="card empty">
		<span class="empty-icon"><Icon name="check-circle" size={40} stroke={1.6} /></span>
		<h3>All clear for today</h3>
		<p class="muted">
			{simple
				? "Nothing for you to do right now."
				: "Tasks with a due date or repeat show up here on the day, along with to-dos assigned to you."}
		</p>
		{#if !simple}<a class="button" href={href("new-task")}><Icon name="plus" size={20} />New task</a
			>{/if}
	</div>
{:else}
	{#if dueNow.length}
		<h3 class="section-label">Due now</h3>
		{#each dueNow as item (item.occurrence.id)}
			<section
				class="card task-card c-{item.task.colour ?? 'none'}"
				class:missed={item.occurrence.status === "missed"}
			>
				<OccurrenceCard task={item.task} occurrence={item.occurrence} {meId} {timeZone} showTitle />
			</section>
		{/each}
	{/if}

	{#if later.length}
		<h3 class="section-label">Later today</h3>
		{#each featured as item (item.occurrence.id)}
			<section
				class="card task-card c-{item.task.colour ?? 'none'}"
				class:next={!simple && !dueNow.length}
			>
				{#if !simple && !dueNow.length}<span class="badge accent next-badge">Up next</span>{/if}
				<OccurrenceCard task={item.task} occurrence={item.occurrence} {meId} {timeZone} showTitle />
			</section>
		{/each}
		{#if rest.length}
			<section class="card rows">
				{#each rest as item (item.occurrence.id)}
					<div class="compact-row">
						<OccurrenceCard
							task={item.task}
							occurrence={item.occurrence}
							{meId}
							{timeZone}
							compact
						/>
					</div>
				{/each}
			</section>
		{/if}
	{/if}

	{#if todos.length}
		<h3 class="section-label">Your to-dos</h3>
		{#if simple}
			{#each todos as task (task.id)}
				<section class="card">
					<a class="todo-title" href={href("task", task.id)}>{task.title}</a>
					<button class="done-button" onclick={() => markDone(task)} {disabled}
						><Icon name="check" size={22} stroke={2.5} />Done</button
					>
				</section>
			{/each}
		{:else}
			<section class="card rows">
				<ul class="list">
					{#each todos as task (task.id)}
						<TaskRow {task} {timeZone} {meId}>
							{#snippet action()}
								<button class="secondary small" onclick={() => markDone(task)} {disabled}
									><Icon name="check" size={18} />Done</button
								>
							{/snippet}
						</TaskRow>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}

	{#if done.length}
		<details class="card done-today">
			<summary
				><span class="tick"><Icon name="check-circle" size={20} /></span>Done today ({done.length})</summary
			>
			{#each done as item (item.occurrence.id)}
				<div class="done-item">
					<OccurrenceCard
						task={item.task}
						occurrence={item.occurrence}
						{meId}
						{timeZone}
						showTitle
					/>
				</div>
			{/each}
		</details>
	{/if}
{/if}

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if simple}
	<p class="full-view"><button class="link" onclick={fullView}>Switch to full view</button></p>
{/if}

<style>
	.broken {
		align-items: center;
		text-decoration: none;
	}
	.fix {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		margin-left: auto;
		font-weight: 700;
		white-space: nowrap;
	}
	.hello {
		margin: 4px 4px 20px;
	}
	.date {
		margin: 0 0 2px;
		font-size: 0.85rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--accent-text);
	}
	.summary {
		margin: 6px 0 0;
	}
	.next {
		box-shadow:
			0 0 0 2px var(--accent),
			var(--shadow);
	}
	.next-badge {
		margin-bottom: 8px;
	}
	.rows {
		padding-top: 4px;
		padding-bottom: 4px;
	}
	.compact-row {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.compact-row:last-child {
		border-bottom: 0;
	}
	.done-today {
		padding-top: 4px;
		padding-bottom: 4px;
	}
	.tick {
		display: flex;
		color: var(--success);
	}
	.done-item {
		padding: 12px 0;
		border-top: 1px solid var(--border);
	}
	.empty {
		text-align: center;
		padding: 32px 20px;
	}
	.empty-icon {
		display: inline-flex;
		color: var(--accent-text);
		margin-bottom: 8px;
	}
	.empty p {
		max-width: 28em;
		margin: 0 auto 16px;
	}
	.todo-title {
		display: block;
		margin-bottom: 12px;
		color: var(--text);
		font-size: 1.12rem;
	}
	.full-view {
		text-align: center;
		margin-top: 32px;
	}
</style>
