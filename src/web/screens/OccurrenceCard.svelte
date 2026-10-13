<script lang="ts">
	import type { OccurrenceState, TaskState } from "../../shared/sync.ts";
	import { formatTime, formatWhen } from "../../shared/time.ts";
	import Avatar from "../components/Avatar.svelte";
	import Icon from "../components/Icon.svelte";
	import { href } from "../router.svelte.ts";
	import { isPending, live, memberName, reminderWarning, send } from "../sync.svelte.ts";

	// One occurrence with its Done / Undo controls (FR-15, FR-18, FR-22).
	// `showTitle` is for lists of occurrences (Today); `compact` is a single row with a small Done button.
	let {
		task,
		occurrence,
		meId,
		timeZone,
		showTitle = false,
		compact = false,
	}: {
		task: TaskState;
		occurrence: OccurrenceState;
		meId: string;
		timeZone: string;
		showTitle?: boolean;
		compact?: boolean;
	} = $props();

	/** Further ahead than this, Done is a smaller "Done early" button so it isn't tapped by mistake. */
	const EARLY_MS = 12 * 60 * 60 * 1000;

	let note = $state("");
	let addingNote = $state(false);
	const now = Date.now();
	const disabled = $derived(live.status !== "live");
	const onBehalf = $derived(task.assigneeId !== null && task.assigneeId !== meId);
	const canComplete = $derived(isPending(occurrence) && !task.archived);
	const missed = $derived(occurrence.status === "missed");
	const early = $derived(occurrence.dueAt - now >= EARLY_MS);
	const when = (ms: number) => formatWhen(ms, timeZone, Date.now());
	// The assignee won't get the reminder (FR-42); the screen explains it once, here it's an icon.
	const unreachable = $derived(
		isPending(occurrence) &&
			task.assigneeId !== null &&
			task.assigneeId !== meId &&
			reminderWarning(task) !== null,
	);
	// Checklist ticks belong to this occurrence (FR-17).
	const ticked = $derived(
		task.subtasks.filter((s) => occurrence.ticks.some((t) => t.subtaskId === s.id)).length,
	);
	const doneLabel = $derived(onBehalf ? `Done for ${memberName(task.assigneeId)}` : "Done");

	const patch = (change: Partial<OccurrenceState>) => (tasks: Record<string, TaskState>) => {
		const o = tasks[task.id]?.occurrences.find((x) => x.id === occurrence.id);
		if (o) Object.assign(o, change);
	};

	async function done() {
		const at = Date.now();
		const overdue = task.schedule?.overdueAfterMinutes ?? null;
		const late = overdue !== null && at > occurrence.dueAt + overdue * 60_000;
		const text = note.trim() || null;
		const saved = await send(
			{ type: "occurrence.done", id: occurrence.id, at, note: text },
			patch({
				status: late ? "done_late" : "done",
				doneAt: at,
				doneBy: meId,
				onBehalf,
				note: text,
			}),
		);
		if (saved) {
			note = "";
			addingNote = false;
		}
	}

	const undo = () =>
		send(
			{ type: "occurrence.reopen", id: occurrence.id },
			patch({
				status: occurrence.missedAlertSent ? "missed" : "open",
				doneAt: null,
				doneBy: null,
				onBehalf: false,
				note: null,
			}),
		);
</script>

{#snippet assignee()}
	{#if task.assigneeId === meId}
		<span class="person"><Icon name="person" size={16} />You</span>
	{:else if task.assigneeId}
		<span class="person">
			<Avatar id={task.assigneeId} name={memberName(task.assigneeId)} size={22} />
			{memberName(task.assigneeId)}
			{#if unreachable}
				<span class="unreachable" title="Can't receive notifications"
					><Icon name="bell-off" size={16} /><span class="sr">(can't receive notifications)</span
					></span
				>
			{/if}
		</span>
	{/if}
{/snippet}

{#if compact}
	<div class="compact">
		<a class="row-link" href={href("task", task.id)}>
			<span class="text">
				<span class="title">{task.title}</span>
				<span class="meta">
					<span class="time"
						><Icon name="clock" size={14} />{formatTime(occurrence.dueAt, timeZone)}</span
					>
					{#if task.subtasks.length}
						<span class="progress"
							><Icon name="list" size={14} />{ticked}/{task.subtasks.length}</span
						>
					{/if}
					{#if task.label}<span class="tag c-{task.colour ?? 'grey'}">{task.label}</span>{/if}
					{@render assignee()}
				</span>
			</span>
		</a>
		{#if canComplete}
			<button class="secondary small" onclick={done} {disabled} aria-label={doneLabel}
				><Icon name="check" size={18} />Done</button
			>
		{/if}
	</div>
{:else}
	<div class="occurrence">
		{#if showTitle}
			<div class="head">
				<a class="title" href={href("task", task.id)}>{task.title}</a>
				{#if missed}
					<span class="badge danger">Missed</span>
				{:else if isPending(occurrence)}
					<span class="badge accent"><Icon name="clock" size={14} />{when(occurrence.dueAt)}</span>
				{/if}
			</div>
		{/if}

		<div class="meta">
			{#if !showTitle || missed}
				<span class:late={missed}
					>{missed ? "Was due" : occurrence.doneAt === null ? "Due" : "Was due"}
					{when(occurrence.dueAt)}</span
				>
			{/if}
			{#if showTitle && task.label}<span class="tag c-{task.colour ?? 'grey'}">{task.label}</span
				>{/if}
			{@render assignee()}
		</div>

		{#if occurrence.doneAt !== null}
			<div class="done-row">
				<p class="done-text">
					<span class="tick"><Icon name="check-circle" size={20} /></span>
					<span>
						{occurrence.status === "done_late" ? "Done late" : "Done"} by {memberName(
							occurrence.doneBy,
						)}{occurrence.onBehalf ? ` for ${memberName(task.assigneeId)}` : ""} at {when(
							occurrence.doneAt,
						)}
						{#if occurrence.note}<br /><span class="muted">“{occurrence.note}”</span>{/if}
					</span>
				</p>
				{#if !task.archived}<button class="ghost small" onclick={undo} {disabled}>Undo</button>{/if}
			</div>
		{:else if canComplete}
			{#if onBehalf && addingNote}
				<label
					>Note (optional) <input
						bind:value={note}
						maxlength="200"
						placeholder="e.g. Gave them myself"
					/></label
				>
			{/if}
			{#if early}
				<button class="secondary" onclick={done} {disabled}
					><Icon name="check" size={18} />{doneLabel} early</button
				>
			{:else}
				<button class="done-button" onclick={done} {disabled}
					><Icon name="check" size={22} stroke={2.5} />{doneLabel}</button
				>
			{/if}
			{#if onBehalf && !addingNote}<button class="link" onclick={() => (addingNote = true)}
					>+ Add a note</button
				>{/if}
		{/if}

		{#if occurrence.alertNotDelivered}
			<p class="error small">The missed alert didn't reach any watcher's phone.</p>
		{/if}
	</div>
{/if}

<style>
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 4px;
	}
	.title {
		color: var(--text);
		font-size: 1.12rem;
		font-weight: 650;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.head .badge {
		margin-top: 2px;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		margin-bottom: 12px;
		color: var(--muted);
		font-size: 0.92rem;
	}
	.late {
		color: var(--danger);
		font-weight: 600;
	}
	.person {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.unreachable {
		display: inline-flex;
		color: var(--warn);
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	.done-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.done-text {
		display: flex;
		gap: 8px;
		margin: 0;
	}
	.tick {
		color: var(--success);
		display: flex;
		margin-top: 1px;
	}
	.link {
		margin-top: 4px;
	}
	.compact {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.time {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-weight: 650;
		color: var(--accent-text);
		font-variant-numeric: tabular-nums;
	}
	.text {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.compact .title {
		font-size: 1rem;
	}
	.progress {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-variant-numeric: tabular-nums;
	}
	.compact .meta {
		margin: 0;
		font-size: 0.85rem;
	}
</style>
