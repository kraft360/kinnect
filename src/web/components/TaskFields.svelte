<script lang="ts" module>
	import type { LabelColour } from "../../shared/labels.ts";
	import type { ScheduleDraft } from "../schedule-draft.ts";

	/** What the task form edits; each screen turns it into its own ops. */
	export interface TaskDraft {
		title: string;
		teamId: string;
		notes: string;
		/** One item per line; only when creating (an existing task edits its checklist in place). */
		checklist: string;
		assigneeId: string;
		watcherIds: string[];
		label: string;
		colour: LabelColour | null;
		schedule: ScheduleDraft;
	}
</script>

<script lang="ts">
	import { TASK_LIMITS } from "../../shared/sync.ts";
	import LabelPicker from "../screens/LabelPicker.svelte";
	import ScheduleEditor from "../screens/ScheduleEditor.svelte";
	import { eligiblePeople, live } from "../sync.svelte.ts";
	import Icon, { type IconName } from "./Icon.svelte";

	// The task editor (FR-33): starts with just a title; optional parts are added with chips.
	let { fields = $bindable(), mode }: { fields: TaskDraft; mode: "create" | "edit" } = $props();

	// svelte-ignore state_referenced_locally (parts that already have a value start open)
	let shown = $state({
		checklist: false,
		assign: fields.assigneeId !== "",
		watchers: fields.watcherIds.length > 0,
		notes: fields.notes !== "",
		label: fields.label !== "",
	});

	const people = $derived(eligiblePeople(fields.teamId || null));

	// Changing the household drops people who aren't in it (FR-86).
	$effect(() => {
		const allowed = new Set(people.map((p) => p.id));
		if (fields.assigneeId && !allowed.has(fields.assigneeId)) fields.assigneeId = "";
		if (fields.watcherIds.some((id) => !allowed.has(id)))
			fields.watcherIds = fields.watcherIds.filter((id) => allowed.has(id));
	});

	const toggleWatcher = (id: string) =>
		(fields.watcherIds = fields.watcherIds.includes(id)
			? fields.watcherIds.filter((w) => w !== id)
			: [...fields.watcherIds, id]);

	type Chip = { icon: IconName; text: string; add: () => void };
	const chips = $derived(
		(<(Chip | false)[]>[
			fields.schedule.mode === "none" && {
				icon: "calendar",
				text: "Due date",
				add: () => (fields.schedule.mode = "once"),
			},
			fields.schedule.mode === "none" && {
				icon: "repeat",
				text: "Repeat",
				add: () => (fields.schedule.mode = "repeat"),
			},
			mode === "create" &&
				!shown.checklist && {
					icon: "list",
					text: "Checklist",
					add: () => (shown.checklist = true),
				},
			!shown.assign && { icon: "person", text: "Assign", add: () => (shown.assign = true) },
			!shown.watchers && { icon: "eye", text: "Watchers", add: () => (shown.watchers = true) },
			!shown.label && { icon: "label", text: "Label", add: () => (shown.label = true) },
			!shown.notes && { icon: "note", text: "Notes", add: () => (shown.notes = true) },
		]).filter((c): c is Chip => c !== false),
	);
</script>

<label class="title">
	<span class="visually-hidden">What needs doing?</span>
	<!-- svelte-ignore a11y_autofocus (the one thing to type on this screen) -->
	<input
		bind:value={fields.title}
		maxlength={TASK_LIMITS.title}
		placeholder="What needs doing?"
		autofocus={mode === "create"}
	/>
</label>

<label class="inline">
	<span class="inline-label"><Icon name="home" size={18} />For</span>
	<select bind:value={fields.teamId}>
		<option value="">The whole family</option>
		{#each live.teams as team (team.id)}<option value={team.id}>{team.name}</option>{/each}
	</select>
</label>

<ScheduleEditor bind:draft={fields.schedule} />

{#if shown.checklist}
	<label
		>Checklist <span class="muted hint">one item per line</span><textarea
			bind:value={fields.checklist}
			rows="5"></textarea></label
	>
{/if}
{#if shown.assign}
	<label class="inline">
		<span class="inline-label"><Icon name="person" size={18} />Assigned to</span>
		<select bind:value={fields.assigneeId}>
			<option value="">Anyone</option>
			{#each people as person (person.id)}<option value={person.id}>{person.displayName}</option
				>{/each}
		</select>
	</label>
{/if}
{#if shown.watchers}
	<fieldset>
		<legend>Watchers <span class="muted hint">alerted if it isn't done</span></legend>
		{#each people as person (person.id)}
			<label class="check"
				><input
					type="checkbox"
					checked={fields.watcherIds.includes(person.id)}
					onchange={() => toggleWatcher(person.id)}
				/>
				{person.displayName}</label
			>
		{/each}
	</fieldset>
{/if}
{#if shown.label}
	<LabelPicker bind:label={fields.label} bind:colour={fields.colour} />
{/if}
{#if shown.notes}
	<label
		>Notes <textarea bind:value={fields.notes} rows="3" maxlength={TASK_LIMITS.notes}
		></textarea></label
	>
{/if}

{#if chips.length}
	<p class="add-label muted">Add</p>
	<div class="chips">
		{#each chips as chip (chip.text)}
			<button type="button" class="chip" onclick={chip.add}
				><Icon name={chip.icon} size={17} />{chip.text}</button
			>
		{/each}
	</div>
{/if}

<style>
	.title input {
		min-height: 56px;
		font-size: 1.2rem;
		font-weight: 600;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	.inline {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.inline-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex: none;
		min-width: 8.6em;
		color: var(--muted);
	}
	.inline select {
		margin: 0;
	}
	.hint {
		font-weight: 400;
		font-size: 0.85rem;
	}
	.add-label {
		margin: 4px 0 6px;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
</style>
