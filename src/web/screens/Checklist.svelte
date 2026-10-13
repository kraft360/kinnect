<script lang="ts">
	import {
		TASK_LIMITS,
		type OccurrenceState,
		type SubtaskState,
		type TaskState,
	} from "../../shared/sync.ts";
	import Icon from "../components/Icon.svelte";
	import { live, memberName, send } from "../sync.svelte.ts";

	// On a scheduled task, ticks belong to one occurrence and each starts unticked (FR-17).
	let {
		task,
		meId,
		occurrence = null,
	}: { task: TaskState; meId: string; occurrence?: OccurrenceState | null } = $props();

	let newItem = $state("");
	let editing = $state<{ id: string; title: string } | null>(null);
	const scheduled = $derived(task.schedule !== null);
	const tick = (item: SubtaskState) =>
		scheduled
			? (occurrence?.ticks.find((t) => t.subtaskId === item.id) ?? null)
			: item.doneAt === null
				? null
				: { doneAt: item.doneAt, doneBy: item.doneBy };
	// Unticked items first, each group by position.
	const items = $derived(
		[...task.subtasks].sort(
			(a, b) => Number(tick(a) !== null) - Number(tick(b) !== null) || a.position - b.position,
		),
	);
	const open = $derived(items.filter((s) => tick(s) === null));
	const disabled = $derived(live.status !== "live");

	/** Changes one item in the local copy right away (optimistic). */
	const local =
		(id: string, change: Partial<SubtaskState>) => (tasks: Record<string, TaskState>) => {
			const item = tasks[task.id]?.subtasks.find((s) => s.id === id);
			if (item) Object.assign(item, change);
		};

	async function add(event: SubmitEvent) {
		event.preventDefault();
		const title = newItem.trim().slice(0, TASK_LIMITS.subtaskTitle);
		if (!title) return;
		newItem = "";
		const id = crypto.randomUUID();
		const position = Math.max(0, ...task.subtasks.map((s) => s.position)) + 1;
		await send({ type: "subtask.add", taskId: task.id, id, title, position }, (tasks) => {
			tasks[task.id]?.subtasks.push({
				id,
				title,
				note: null,
				position,
				doneAt: null,
				doneBy: null,
			});
		});
	}

	/** Changes one occurrence's ticks in the local copy right away. */
	const localTicks =
		(change: (ticks: OccurrenceState["ticks"]) => OccurrenceState["ticks"]) =>
		(tasks: Record<string, TaskState>) => {
			const o = tasks[task.id]?.occurrences.find((x) => x.id === occurrence?.id);
			if (o) o.ticks = change(o.ticks);
		};

	function toggle(item: SubtaskState) {
		if (scheduled) {
			if (!occurrence) return;
			const occurrenceId = occurrence.id;
			return tick(item) === null
				? send(
						{ type: "occurrence.tick", occurrenceId, subtaskId: item.id },
						localTicks((ticks) => [
							...ticks,
							{ subtaskId: item.id, doneAt: Date.now(), doneBy: meId },
						]),
					)
				: send(
						{ type: "occurrence.untick", occurrenceId, subtaskId: item.id },
						localTicks((ticks) => ticks.filter((t) => t.subtaskId !== item.id)),
					);
		}
		return item.doneAt === null
			? send(
					{ type: "subtask.tick", id: item.id },
					local(item.id, { doneAt: Date.now(), doneBy: meId }),
				)
			: send(
					{ type: "subtask.untick", id: item.id },
					local(item.id, { doneAt: null, doneBy: null }),
				);
	}

	/** Moves an unticked item up or down by placing it between its new neighbours. */
	function move(item: SubtaskState, direction: -1 | 1) {
		const i = open.findIndex((s) => s.id === item.id);
		const target = i + direction;
		if (target < 0 || target >= open.length) return;
		const neighbour = open[target];
		const beyond = open[target + direction];
		const position = beyond
			? (neighbour.position + beyond.position) / 2
			: neighbour.position + direction;
		send({ type: "subtask.move", id: item.id, position }, local(item.id, { position }));
	}

	async function saveEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editing) return;
		const { id, title } = editing;
		editing = null;
		if (title.trim())
			await send(
				{ type: "subtask.update", id, title: title.trim() },
				local(id, { title: title.trim() }),
			);
	}

	const remove = (item: SubtaskState) =>
		send({ type: "subtask.remove", id: item.id }, (tasks) => {
			const t = tasks[task.id];
			if (t) t.subtasks = t.subtasks.filter((s) => s.id !== item.id);
		});

	const clearCompleted = () =>
		send({ type: "task.clearCompleted", id: task.id }, (tasks) => {
			const t = tasks[task.id];
			if (t) t.subtasks = t.subtasks.filter((s) => s.doneAt === null);
		});
</script>

<ul class="list">
	{#each items as item (item.id)}
		{@const ticked = tick(item)}
		<li class:ticked={ticked !== null}>
			{#if editing?.id === item.id}
				<form class="edit" onsubmit={saveEdit}>
					<input bind:value={editing.title} maxlength={TASK_LIMITS.subtaskTitle} />
					<button type="submit" class="small">Save</button>
				</form>
			{:else}
				<label class="item">
					<input
						type="checkbox"
						checked={ticked !== null}
						onchange={() => toggle(item)}
						disabled={disabled || (scheduled && !occurrence)}
					/>
					<span>
						{item.title}
						{#if item.note}<span class="muted">({item.note})</span>{/if}
						{#if ticked && ticked.doneBy && ticked.doneBy !== meId}<span class="muted small">
								· {memberName(ticked.doneBy)}</span
							>{/if}
					</span>
				</label>
				<span class="tools">
					{#if ticked === null}
						<button
							class="icon-button"
							aria-label="Move up"
							onclick={() => move(item, -1)}
							{disabled}><Icon name="up" size={18} /></button
						>
						<button
							class="icon-button"
							aria-label="Move down"
							onclick={() => move(item, 1)}
							{disabled}><Icon name="down" size={18} /></button
						>
						<button
							class="icon-button"
							aria-label="Edit {item.title}"
							onclick={() => (editing = { id: item.id, title: item.title })}
							{disabled}><Icon name="edit" size={17} /></button
						>
					{/if}
					<button
						class="icon-button"
						aria-label="Remove {item.title}"
						onclick={() => remove(item)}
						{disabled}><Icon name="x" size={18} /></button
					>
				</span>
			{/if}
		</li>
	{/each}
</ul>

<form class="add" onsubmit={add}>
	<input
		bind:value={newItem}
		maxlength={TASK_LIMITS.subtaskTitle}
		placeholder="Add an item"
		aria-label="New checklist item"
		{disabled}
	/>
	<button
		type="submit"
		class="secondary"
		disabled={disabled || !newItem.trim()}
		aria-label="Add item"><Icon name="plus" size={20} /></button
	>
</form>

{#if !scheduled && items.length > open.length}
	<button class="ghost small" onclick={clearCompleted} {disabled}>Clear completed</button>
{/if}

<style>
	.item {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 0;
		font-weight: 400;
		font-size: 1rem;
		flex: 1;
		min-height: var(--tap);
	}
	.item input {
		width: 26px;
		height: 26px;
	}
	.ticked span {
		text-decoration: line-through;
		color: var(--muted);
	}
	.tools {
		display: flex;
		gap: 0;
	}
	.tools .icon-button {
		width: 40px;
		min-height: 40px;
	}
	.edit,
	.add {
		display: flex;
		gap: 8px;
		flex: 1;
		align-items: center;
	}
	.add {
		margin: 8px 0 4px;
	}
	.add button {
		width: var(--tap);
		padding: 0;
		flex: none;
	}
	.edit input,
	.add input {
		margin: 0;
	}
</style>
