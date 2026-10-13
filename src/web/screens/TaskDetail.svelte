<script lang="ts">
	import { describeSchedule, formatMinutes, parseSchedule } from "../../shared/schedule.ts";
	import { TASK_LIMITS, type TaskState } from "../../shared/sync.ts";
	import type { MeResponse } from "../../shared/types.ts";
	import { href } from "../router.svelte.ts";
	import Avatar from "../components/Avatar.svelte";
	import Icon from "../components/Icon.svelte";
	import PageHeader from "../components/PageHeader.svelte";
	import TaskFields, { type TaskDraft } from "../components/TaskFields.svelte";
	import { draftFrom, toSchedule } from "../schedule-draft.ts";
	import {
		currentOccurrence,
		eligiblePeople,
		isReachable,
		live,
		liveMember,
		memberName,
		reminderWarning,
		send,
		teamName,
	} from "../sync.svelte.ts";
	import Checklist from "./Checklist.svelte";
	import OccurrenceCard from "./OccurrenceCard.svelte";
	import OfflineBanner from "./OfflineBanner.svelte";

	// In simple view (FR-34) the page is just the task, its checklist and Done.
	let {
		me,
		taskId,
		simple = false,
	}: { me: MeResponse; taskId: string; simple?: boolean } = $props();

	const task = $derived(live.tasks[taskId]);
	const disabled = $derived(live.status !== "live");
	let editing = $state<TaskDraft | null>(null);
	let editError = $state("");
	const timeZone = $derived(me.organization.timezone);
	const current = $derived(task ? currentOccurrence(task) : null);
	// Past occurrences other than the current one, newest first (FR-19; full history is Phase 2).
	const history = $derived(
		task
			? task.occurrences.filter((o) => o.dueAt <= Date.now() && o.id !== current?.id).reverse()
			: [],
	);

	const patch = (change: Partial<TaskState>) => (tasks: Record<string, TaskState>) => {
		if (tasks[taskId]) Object.assign(tasks[taskId], change);
	};

	const markDone = () =>
		send({ type: "task.done", id: taskId }, patch({ doneAt: Date.now(), doneBy: me.member.id }));
	const reopen = () =>
		send({ type: "task.reopen", id: taskId }, patch({ doneAt: null, doneBy: null }));
	const setArchived = (archived: boolean) =>
		send({ type: archived ? "task.archive" : "task.unarchive", id: taskId }, patch({ archived }));

	function startEdit(t: TaskState) {
		editing = {
			title: t.title,
			notes: t.notes ?? "",
			checklist: "",
			label: t.label ?? "",
			colour: t.colour ?? "teal",
			teamId: t.teamId ?? "",
			assigneeId: t.assigneeId ?? "",
			watcherIds: [...t.watcherIds],
			schedule: draftFrom(t.schedule, me.organization.defaultDueTime, timeZone),
		};
		editError = "";
	}

	async function saveEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editing || !task || !editing.title.trim()) return;
		const e = editing;
		const changes: Partial<
			Pick<TaskState, "title" | "notes" | "label" | "colour" | "teamId" | "assigneeId">
		> = {};
		if (e.title.trim() !== task.title) changes.title = e.title.trim();
		if ((e.notes.trim() || null) !== task.notes) changes.notes = e.notes.trim() || null;
		const label = e.label.trim() || null;
		const colour = label ? e.colour : null;
		if (label !== task.label) changes.label = label;
		if (colour !== task.colour) changes.colour = colour;
		if ((e.teamId || null) !== task.teamId) changes.teamId = e.teamId || null;
		if ((e.assigneeId || null) !== task.assigneeId) changes.assigneeId = e.assigneeId || null;
		const allowed = new Set(eligiblePeople(e.teamId || null).map((p) => p.id));
		const watchers = e.watcherIds.filter((id) => allowed.has(id));
		const watchersChanged = [...watchers].sort().join() !== [...task.watcherIds].sort().join();
		const schedule = toSchedule(e.schedule);
		const checked = schedule && parseSchedule(schedule);
		if (typeof checked === "string") {
			editError = `Schedule: ${checked}`;
			return;
		}
		editError = "";
		const scheduleChanged = JSON.stringify(checked) !== JSON.stringify(task.schedule);

		// Watchers first when moving to a household, so nobody outside it is left watching (FR-86).
		if (
			watchersChanged &&
			!(await send(
				{ type: "task.setWatchers", id: taskId, watcherIds: watchers },
				patch({ watcherIds: watchers }),
			))
		)
			return;
		if (
			Object.keys(changes).length &&
			!(await send(
				{ type: "task.update", id: taskId, changes },
				patch(changes as Partial<TaskState>),
			))
		)
			return;
		// The server replaces future occurrences (FR-23).
		if (
			scheduleChanged &&
			!(await send(
				{ type: "task.setSchedule", id: taskId, schedule: checked },
				patch({ schedule: checked }),
			))
		)
			return;
		editing = null;
	}

	const warning = $derived(task ? reminderWarning(task) : null);
	const reminders = $derived(
		task?.schedule
			? [
					task.schedule.remindBeforeMinutes !== null
						? `Reminder ${formatMinutes(task.schedule.remindBeforeMinutes)} before`
						: "",
					task.schedule.secondReminderMinutes !== null
						? `again after ${formatMinutes(task.schedule.secondReminderMinutes)}`
						: "",
					task.schedule.overdueAfterMinutes !== null
						? `missed after ${formatMinutes(task.schedule.overdueAfterMinutes)}`
						: "never marked missed",
				]
					.filter(Boolean)
					.join(" · ")
			: "",
	);
	/** People on the task, flagged when a scheduled task's reminders can't reach them (FR-42). */
	const person = (id: string) => {
		const m = liveMember(id);
		return { id, name: memberName(id), unreachable: !!(task?.schedule && m && !isReachable(m)) };
	};
	const when = (ms: number) =>
		new Date(ms).toLocaleString(undefined, {
			day: "numeric",
			month: "short",
			hour: "numeric",
			minute: "2-digit",
		});
</script>

<OfflineBanner />

{#if !task}
	<PageHeader
		title="Task"
		back={{ href: href(simple ? "today" : "tasks"), label: simple ? "Today" : "Tasks" }}
	/>
	<p class="muted">
		{live.syncedVersion === null ? "Loading…" : "This task doesn't exist or you can't see it."}
	</p>
{:else if editing}
	<PageHeader title="Edit task" />
	<form class="card" onsubmit={saveEdit}>
		<TaskFields bind:fields={editing} mode="edit" />
		{#if task.schedule && editing.schedule.mode !== "none"}<p class="muted small">
				Schedule changes apply from now on.
			</p>{/if}
		{#if editError}<p class="error" role="alert">{editError}</p>{/if}
		<div class="actions">
			<button type="submit" {disabled}>Save</button>
			<button type="button" class="ghost" onclick={() => (editing = null)}>Cancel</button>
		</div>
	</form>
{:else}
	<PageHeader
		title={task.title}
		back={{ href: href(simple ? "today" : "tasks"), label: simple ? "Today" : "Tasks" }}
		done={task.doneAt !== null}
	>
		{#snippet action()}
			{#if !simple && !task.archived}
				<button class="secondary small" onclick={() => startEdit(task)} {disabled}
					><Icon name="edit" size={17} />Edit</button
				>
			{/if}
		{/snippet}
		{#snippet subtitle()}
			{#if task.label}<span class="tag c-{task.colour ?? 'grey'}">{task.label}</span>{/if}
			<span class="item"
				><Icon name={task.teamId ? "home" : "people"} size={16} />{teamName(task.teamId)}</span
			>
			{#if task.archived}<span class="badge">Archived</span>{/if}
		{/snippet}
	</PageHeader>

	{#if warning && !simple}
		<div class="callout warn">
			<Icon name="bell-off" />
			<p class="body"><strong>{warning}.</strong> Reminders for this task won't reach them.</p>
		</div>
	{/if}

	{#if task.schedule}
		<section
			class="card task-card c-{task.colour ?? 'none'}"
			class:missed={current?.status === "missed"}
		>
			{#if current}
				<OccurrenceCard {task} occurrence={current} meId={me.member.id} {timeZone} />
			{:else if !task.archived}
				<p class="muted">Nothing due right now.</p>
			{/if}
			<div class="schedule">
				<Icon name={task.schedule.repeat ? "repeat" : "calendar"} size={18} />
				<div>
					<p class="schedule-text">{describeSchedule(task.schedule)}</p>
					<p class="muted small">{reminders}</p>
				</div>
			</div>
		</section>
	{:else if !task.archived}
		{#if task.doneAt === null}
			<button class="done-button status" onclick={markDone} {disabled}
				><Icon name="check" size={22} stroke={2.5} />Done</button
			>
		{:else}
			<div class="card done-card">
				<span class="tick"><Icon name="check-circle" /></span>
				<p class="body">Done by {memberName(task.doneBy)} on {when(task.doneAt)}</p>
				<button class="ghost small" onclick={reopen} {disabled}>Undo</button>
			</div>
		{/if}
	{/if}

	{#if task.subtasks.length || !task.archived}
		<h3 class="section-label">Checklist</h3>
		<section class="card">
			<Checklist {task} meId={me.member.id} occurrence={current} />
		</section>
	{/if}

	{#if task.notes}
		<h3 class="section-label">Notes</h3>
		<p class="card notes">{task.notes}</p>
	{/if}

	{#if !simple && (task.assigneeId || task.watcherIds.length)}
		<h3 class="section-label">People</h3>
		<section class="card">
			<ul class="list">
				{#each [...(task.assigneeId ? [{ ...person(task.assigneeId), role: "Assigned" }] : []), ...task.watcherIds.map( (id) => ({ ...person(id), role: "Watching" }) )] as p (p.role + p.id)}
					<li>
						<span class="person">
							<Avatar id={p.id} name={p.name} size={32} />
							<span>
								{p.name}
								{#if p.unreachable}<span class="badge warn"
										><Icon name="bell-off" size={13} />No notifications</span
									>{/if}
							</span>
						</span>
						<span class="muted small">{p.role}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if history.length}
		<h3 class="section-label">Recent</h3>
		<section class="card">
			{#each history as occurrence (occurrence.id)}
				<div class="history">
					<OccurrenceCard {task} {occurrence} meId={me.member.id} {timeZone} />
				</div>
			{/each}
		</section>
	{/if}

	{#if !simple}
		<div class="footer">
			<button
				class="ghost small"
				class:danger={!task.archived}
				onclick={() => setArchived(!task.archived)}
				{disabled}
			>
				<Icon name="archive" size={17} />{task.archived ? "Restore" : "Archive"}
			</button>
			<p class="muted small">Created by {memberName(task.createdBy)} on {when(task.createdAt)}</p>
		</div>
	{/if}
{/if}

<style>
	.item {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.status {
		margin-bottom: 12px;
	}
	.schedule {
		display: flex;
		gap: 10px;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
		color: var(--muted);
	}
	.schedule p {
		margin: 0;
	}
	.schedule-text {
		color: var(--text);
		font-weight: 600;
	}
	.done-card {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.done-card .body {
		flex: 1;
		margin: 0;
	}
	.tick {
		display: flex;
		color: var(--success);
	}
	.notes {
		white-space: pre-wrap;
	}
	.person {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.person .badge {
		margin-left: 6px;
	}
	.history {
		padding: 10px 0;
		border-bottom: 1px solid var(--border);
	}
	.history:first-child {
		padding-top: 0;
	}
	.history:last-child {
		border-bottom: 0;
		padding-bottom: 0;
	}
	.footer {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		margin-top: 20px;
	}
</style>
