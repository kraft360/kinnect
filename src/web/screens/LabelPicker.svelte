<script lang="ts">
	import { LABEL_COLOURS, type LabelColour } from "../../shared/labels.ts";
	import { TASK_LIMITS } from "../../shared/sync.ts";
	import { labelsInUse } from "../sync.svelte.ts";

	// A label and colour for visual grouping (FR-4); suggests labels the family already uses.
	let { label = $bindable(), colour = $bindable() }: { label: string; colour: LabelColour | null } =
		$props();

	const suggestions = labelsInUse();
	const listId = `labels-${Math.random().toString(36).slice(2)}`;

	function pickedLabel() {
		const known = suggestions.find((s) => s.label === label.trim());
		if (known?.colour) colour = known.colour;
	}
</script>

<fieldset>
	<legend>Label</legend>
	<label>
		Name
		<input
			bind:value={label}
			onchange={pickedLabel}
			list={listId}
			maxlength={TASK_LIMITS.label}
			placeholder="e.g. Health, Groceries"
		/>
	</label>
	<datalist id={listId}>
		{#each suggestions as s (s.label)}<option value={s.label}></option>{/each}
	</datalist>
	<div class="colours" role="radiogroup" aria-label="Colour">
		{#each LABEL_COLOURS as c (c)}
			<button
				type="button"
				class="swatch c-{c}"
				class:chosen={colour === c}
				role="radio"
				aria-checked={colour === c}
				aria-label={c}
				onclick={() => (colour = c)}
			></button>
		{/each}
	</div>
	{#if label.trim()}<p>
			Shown as <span class="tag c-{colour ?? 'grey'}">{label.trim()}</span>
		</p>{/if}
</fieldset>

<style>
	.colours {
		display: grid;
		grid-template-columns: repeat(4, 44px);
		gap: 10px;
		margin-bottom: 8px;
	}
	.swatch {
		width: 44px;
		min-height: 44px;
		padding: 0;
		border-radius: 50%;
		background: var(--tag);
		border: 3px solid transparent;
	}
	.swatch.chosen {
		border-color: var(--text);
		box-shadow: inset 0 0 0 3px var(--surface);
	}
</style>
