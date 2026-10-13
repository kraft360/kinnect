<script lang="ts">
	import { parseSchedule } from "../../shared/schedule.ts";
	import { TASK_LIMITS, type TaskState } from "../../shared/sync.ts";
	import type { MeResponse } from "../../shared/types.ts";
	import PageHeader from "../components/PageHeader.svelte";
	import TaskFields, { type TaskDraft } from "../components/TaskFields.svelte";
	import { href } from "../router.svelte.ts";
	import { emptyDraft, toSchedule } from "../schedule-draft.ts";
	import { live, send } from "../sync.svelte.ts";
	import OfflineBanner from "./OfflineBanner.svelte";

	let { me, teamId = "" }: { me: MeResponse; teamId?: string } = $props();

	// svelte-ignore state_referenced_locally (the household link and the family's settings only set the starting values)
	let fields = $state<TaskDraft>({
		title: "",
		teamId,
		notes: "",
		checklist: "",
		assigneeId: "",
		watcherIds: [],
		label: "",
		colour: "teal",
		schedule: emptyDraft(me.organization.defaultDueTime, me.organization.timezone),
	});
	let error = $state("");
	let busy = $state(false);

	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (!fields.title.trim()) return;
		const schedule = toSchedule(fields.schedule);
		const checked = schedule && parseSchedule(schedule);
		error = typeof checked === "string" ? `Schedule: ${checked}` : "";
		if (error) return;
		busy = true;
		const id = crypto.randomUUID();
		const scope = fields.teamId || null;
		const subtasks = fields.checklist
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(0, TASK_LIMITS.subtasks)
			.map((line) => ({ id: crypto.randomUUID(), title: line.slice(0, TASK_LIMITS.subtaskTitle) }));
		const label = fields.label.trim() || null;
		const now = Date.now();
		const draft: TaskState = {
			id,
			teamId: scope,
			title: fields.title.trim(),
			notes: fields.notes.trim() || null,
			label,
			colour: label ? fields.colour : null,
			assigneeId: fields.assigneeId || null,
			watcherIds: fields.watcherIds,
			subtasks: subtasks.map((s, i) => ({
				...s,
				note: null,
				position: i + 1,
				doneAt: null,
				doneBy: null,
			})),
			doneAt: null,
			doneBy: null,
			schedule,
			// The server creates the occurrences.
			occurrences: [],
			archived: false,
			createdBy: me.member.id,
			createdAt: now,
			updatedAt: now,
			version: 0,
		};
		const saved = await send(
			{
				type: "task.create",
				id,
				title: draft.title,
				notes: draft.notes ?? undefined,
				label: draft.label,
				colour: draft.colour,
				teamId: scope,
				assigneeId: draft.assigneeId,
				watcherIds: draft.watcherIds,
				subtasks,
				schedule,
			},
			(tasks) => {
				tasks[id] = draft;
			},
		);
		busy = false;
		if (saved) location.hash = href("task", id);
	}
</script>

<PageHeader title="New task" back={{ href: href("tasks"), label: "Tasks" }} />
<OfflineBanner />

<form class="card" onsubmit={create}>
	<TaskFields bind:fields mode="create" />

	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="submit">
		<button
			type="submit"
			class="block"
			disabled={busy || !fields.title.trim() || live.status !== "live"}
			>{busy ? "Saving…" : "Create task"}</button
		>
	</div>
</form>

<style>
	/* Keeps Create in reach above the nav bar while the form is long. */
	.submit {
		position: sticky;
		bottom: calc(var(--nav-height) + env(safe-area-inset-bottom) + 8px);
		padding-top: 8px;
		background: linear-gradient(transparent, var(--surface) 30%);
	}
</style>
