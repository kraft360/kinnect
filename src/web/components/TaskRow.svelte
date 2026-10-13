<script lang="ts">
	import type { Snippet } from "svelte";
	import type { TaskState } from "../../shared/sync.ts";
	import { formatWhen } from "../../shared/time.ts";
	import { href } from "../router.svelte.ts";
	import { currentOccurrence, memberName, reminderWarning } from "../sync.svelte.ts";
	import Avatar from "./Avatar.svelte";
	import Icon from "./Icon.svelte";

	// One task in a list (FR-31): title, then when it's due, checklist progress, who it's for and its label.
	// With an action (Today's to-dos) the tasks are all yours, so "You" is left out.
	let {
		task,
		timeZone,
		meId,
		action,
	}: { task: TaskState; timeZone: string; meId: string; action?: Snippet } = $props();

	const occurrence = $derived(task.schedule && !task.archived ? currentOccurrence(task) : null);
	const missed = $derived(occurrence?.status === "missed");
	// On a scheduled task, ticks belong to the occurrence shown (FR-17), as in Checklist.
	const ticked = $derived(
		task.schedule
			? task.subtasks.filter((s) => occurrence?.ticks.some((t) => t.subtaskId === s.id)).length
			: task.subtasks.filter((s) => s.doneAt).length,
	);
	const progress = $derived(
		task.subtasks.length && (occurrence || !task.schedule)
			? `${ticked}/${task.subtasks.length}`
			: "",
	);
	const unreachable = $derived(reminderWarning(task) !== null);
</script>

<li class="task-row">
	<a class="row-link" href={href("task", task.id)}>
		<span class="text">
			<span class="title" class:done={task.doneAt !== null}>{task.title}</span>
			<span class="meta">
				{#if occurrence}
					<span class="badge" class:danger={missed} class:accent={!missed}>
						<Icon
							name={missed ? "warning" : task.schedule?.repeat ? "repeat" : "clock"}
							size={13}
						/>
						{missed ? "Missed" : formatWhen(occurrence.dueAt, timeZone, Date.now())}
					</span>
				{:else if task.schedule && !task.archived}
					<span class="item"><Icon name="repeat" size={15} />Nothing due</span>
				{/if}
				{#if progress}<span class="item"><Icon name="list" size={15} />{progress}</span>{/if}
				{#if task.assigneeId === meId}
					{#if !action}<span class="item"><Icon name="person" size={15} />You</span>{/if}
				{:else if task.assigneeId}
					<span class="item">
						<Avatar id={task.assigneeId} name={memberName(task.assigneeId)} size={20} />{memberName(
							task.assigneeId,
						)}
						{#if unreachable}<span class="unreachable" title="Can't receive notifications"
								><Icon name="bell-off" size={15} /></span
							>{/if}
					</span>
				{/if}
				{#if task.label}<span class="tag c-{task.colour ?? 'grey'}">{task.label}</span>{/if}
			</span>
		</span>
	</a>
	{#if action}
		{@render action()}
	{:else}
		<span class="chevron"><Icon name="chevron" size={18} /></span>
	{/if}
</li>

<style>
	.text {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.done {
		text-decoration: line-through;
		color: var(--muted);
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		color: var(--muted);
		font-size: 0.85rem;
	}
	.meta:empty {
		display: none;
	}
	.item {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.unreachable {
		display: inline-flex;
		color: var(--warn);
	}
	.chevron {
		display: flex;
		color: var(--muted);
		opacity: 0.6;
	}
</style>
