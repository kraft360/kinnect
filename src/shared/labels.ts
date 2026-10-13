// Task labels (FR-4): free text plus one of a few fixed colours, for visual grouping only.

export const LABEL_COLOURS = [
	"teal",
	"blue",
	"purple",
	"pink",
	"red",
	"orange",
	"green",
	"grey",
] as const;
export type LabelColour = (typeof LABEL_COLOURS)[number];

export const isLabelColour = (value: unknown): value is LabelColour =>
	(LABEL_COLOURS as readonly unknown[]).includes(value);
