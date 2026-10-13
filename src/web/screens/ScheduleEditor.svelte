<script lang="ts">
	import {
		formatMinutes,
		nextRepeatDates,
		SCHEDULE_LIMITS,
		WEEKDAYS,
		type Weekday,
	} from "../../shared/schedule.ts";
	import { formatDate } from "../../shared/time.ts";
	import Icon from "../components/Icon.svelte";
	import { toSchedule, type ScheduleDraft } from "../schedule-draft.ts";

	// Due date, repeat, Remind before and follow-up settings (FR-24, FR-33). Adding one is a chip in TaskFields.
	let { draft = $bindable() }: { draft: ScheduleDraft } = $props();

	const REMIND_BEFORE = [15, 60, 24 * 60, 3 * 24 * 60, 7 * 24 * 60];
	const SECOND = [5, 10, 15, 30, 60];
	const OVERDUE = [10, 20, 30, 60, 120, 24 * 60];
	const DAY_LABELS: Record<Weekday, string> = {
		SUN: "Sun",
		MON: "Mon",
		TUE: "Tue",
		WED: "Wed",
		THU: "Thu",
		FRI: "Fri",
		SAT: "Sat",
	};

	/** Keeps a value that isn't one of the presets (e.g. set elsewhere) selectable. */
	const withCurrent = (options: number[], current: number | null) =>
		current === null || options.includes(current)
			? options
			: [...options, current].sort((a, b) => a - b);

	const UNITS = {
		daily: ["day", "days"],
		weekly: ["week", "weeks"],
		monthly: ["month", "months"],
	} as const;
	const interval = $derived(draft.mode === "repeat" && draft.every > 1);
	/** The next few days it falls on, so it's clear which days are "on" (from the start, or today if that's later). */
	const preview = $derived.by(() => {
		if (!interval) return [];
		const repeat = toSchedule(draft)?.repeat;
		const today = new Date().toLocaleDateString("en-CA");
		return repeat && draft.start
			? nextRepeatDates(repeat, draft.start > today ? draft.start : today, 3)
			: [];
	});

	const toggleDay = (day: Weekday) =>
		(draft.days = draft.days.includes(day)
			? draft.days.filter((d) => d !== day)
			: [...draft.days, day]);
</script>

{#if draft.mode !== "none"}
	<fieldset>
		<legend
			><Icon name={draft.mode === "once" ? "calendar" : "repeat"} size={16} />{draft.mode === "once"
				? "Due"
				: "Repeat"}</legend
		>
		{#if draft.mode === "once"}
			<div class="row">
				<label>Date <input type="date" bind:value={draft.date} required /></label>
				<label>Time <input type="time" bind:value={draft.time} required /></label>
			</div>
		{:else}
			<div class="every" role="group" aria-label="How often">
				<span>Every</span>
				<input
					type="number"
					inputmode="numeric"
					min="1"
					max={SCHEDULE_LIMITS.repeatEvery[draft.repeatKind]}
					bind:value={draft.every}
					aria-label="Every how many"
				/>
				<select bind:value={draft.repeatKind} aria-label="Days, weeks or months">
					{#each Object.entries(UNITS) as [kind, words] (kind)}<option value={kind}
							>{draft.every > 1 ? words[1] : words[0]}</option
						>{/each}
				</select>
			</div>
			{#if draft.repeatKind === "weekly"}
				<div class="days" role="group" aria-label="Days">
					{#each WEEKDAYS as day (day)}
						<button
							type="button"
							class="chip"
							aria-pressed={draft.days.includes(day)}
							onclick={() => toggleDay(day)}
						>
							{DAY_LABELS[day]}
						</button>
					{/each}
				</div>
			{:else if draft.repeatKind === "monthly"}
				<label
					>Day of the month <input
						type="number"
						min="1"
						max="31"
						bind:value={draft.monthDay}
					/></label
				>
				{#if draft.monthDay > 28}<p class="muted small">
						In shorter months it falls on the last day.
					</p>{/if}
			{/if}
			{#if interval}
				<label>Starting <input type="date" bind:value={draft.start} required /></label>
				{#if preview.length}<p class="muted small next">
						Next: {preview.map((d) => formatDate(d)).join(", ")}
					</p>{/if}
			{/if}
			<div class="times">
				{#each draft.times as _, i (i)}
					<div class="row">
						<label>Time <input type="time" bind:value={draft.times[i]} required /></label>
						{#if draft.times.length > 1}
							<button
								type="button"
								class="icon-button"
								aria-label="Remove time"
								onclick={() => (draft.times = draft.times.filter((_, j) => j !== i))}
								><Icon name="x" size={18} /></button
							>
						{/if}
					</div>
				{/each}
				{#if draft.times.length < SCHEDULE_LIMITS.timesPerDay}
					<button
						type="button"
						class="ghost small"
						onclick={() => (draft.times = [...draft.times, draft.times.at(-1) ?? "09:00"])}
						><Icon name="plus" size={16} />Another time</button
					>
				{/if}
			</div>
		{/if}

		{#if draft.remindBefore !== null}
			<label>
				Remind before
				<select bind:value={draft.remindBefore}>
					<option value={null}>No advance reminder</option>
					{#each withCurrent(REMIND_BEFORE, draft.remindBefore) as m (m)}<option value={m}
							>{formatMinutes(m)} before</option
						>{/each}
				</select>
			</label>
		{/if}

		<details>
			<summary>
				Follow-up: {draft.second === null
					? "no second reminder"
					: `reminder again after ${formatMinutes(draft.second)}`},
				{draft.overdue === null
					? "never marked missed"
					: `missed after ${formatMinutes(draft.overdue)}`}
			</summary>
			<label>
				Remind again if not done after
				<select bind:value={draft.second}>
					<option value={null}>Don't remind again</option>
					{#each withCurrent(SECOND, draft.second) as m (m)}<option value={m}
							>{formatMinutes(m)}</option
						>{/each}
				</select>
			</label>
			<label>
				Mark missed and alert watchers after
				<select bind:value={draft.overdue}>
					{#each withCurrent(OVERDUE, draft.overdue) as m (m)}<option value={m}
							>{formatMinutes(m)}</option
						>{/each}
					<option value={null}>Never</option>
				</select>
			</label>
		</details>

		<div class="chips">
			{#if draft.remindBefore === null}
				<button type="button" class="chip" onclick={() => (draft.remindBefore = 24 * 60)}
					><Icon name="bell" size={16} />Remind before</button
				>
			{/if}
			<button type="button" class="ghost small danger" onclick={() => (draft.mode = "none")}
				>Remove {draft.mode === "once" ? "due date" : "repeat"}</button
			>
		</div>
	</fieldset>
{/if}

<style>
	legend {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.chips {
		align-items: center;
		margin-bottom: 8px;
	}
	.row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}
	.row label {
		flex: 1;
	}
	.row button {
		margin-bottom: 14px;
	}
	.every {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 14px;
		font-weight: 600;
		font-size: 0.95rem;
	}
	.every input {
		width: 5em;
		margin: 0;
		text-align: center;
	}
	.every select {
		flex: 1;
		margin: 0;
	}
	.next {
		margin-top: -6px;
	}
	.days {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 14px;
	}
	.days .chip {
		padding: 0 10px;
		min-width: 50px;
		min-height: var(--tap);
	}
	.times {
		margin-bottom: 8px;
	}
	details {
		margin-bottom: 8px;
	}
	summary {
		color: var(--muted);
		font-weight: 500;
		font-size: 0.92rem;
	}
	.small {
		margin-top: -8px;
	}
</style>
