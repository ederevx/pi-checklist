/**
 * pi-checklist — the `checklist` tool's argument surface.
 *
 * One object carries every action's fields, each optional, so a call reaches
 * the tool as a single shape instead of one variant of a union; a union-rooted
 * schema is delivered to the model variant by variant and its array arguments
 * can arrive as JSON text. Each action's own fields are still enforced, against
 * the matching action schema, before the tool does anything.
 */

import { Type, type TObject, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { MAX_TASKS } from "./checklist-contract.ts";

export type Action = "create" | "add" | "update" | "ack" | "list";

export class ChecklistParameters {
	private readonly actions: Record<Action, TObject>;
	public readonly schema: TObject;

	constructor() {
		const fields: Record<string, TSchema> = {
			title: Type.String({ minLength: 1, maxLength: 200 }),
			tasks: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
				minItems: 1,
				maxItems: MAX_TASKS,
			}),
			checklistId: Type.String({ minLength: 1, maxLength: 100 }),
			revision: Type.Integer({ minimum: 1 }),
			taskId: Type.String({ minLength: 1, maxLength: 100 }),
			status: Type.Union([
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("done"),
			]),
			note: Type.String({ minLength: 1, maxLength: 2000 }),
			summary: Type.String({ minLength: 1, maxLength: 2000 }),
		};
		const actionFields: Record<Action, Record<string, TSchema>> = {
			create: { title: fields.title, tasks: fields.tasks },
			add: { checklistId: fields.checklistId, revision: fields.revision, title: fields.title },
			update: {
				checklistId: fields.checklistId,
				revision: fields.revision,
				taskId: fields.taskId,
				status: fields.status,
				note: Type.Optional(fields.note),
			},
			ack: { checklistId: fields.checklistId, revision: fields.revision, summary: fields.summary },
			list: {},
		};
		const names = Object.keys(actionFields) as Action[];
		this.actions = Object.fromEntries(
			names.map((action) => [
				action,
				Type.Object(
					{ action: Type.Literal(action), ...actionFields[action] },
					{ additionalProperties: false },
				),
			]),
		) as Record<Action, TObject>;
		this.schema = Type.Object(
			{
				action: Type.Union(names.map((action) => Type.Literal(action))),
				...Object.fromEntries(
					Object.entries(fields).map(([name, field]) => [name, Type.Optional(field)]),
				),
			},
			{ additionalProperties: false },
		);
	}

	public schemaFor(action: string): TObject | null {
		return Object.hasOwn(this.actions, action) ? this.actions[action as Action] : null;
	}

	public invalid(schema: TObject, params: Record<string, unknown>): string | null {
		const [failure] = Value.Errors(schema, params);
		if (!failure) return null;
		return `${failure.path === "" ? "arguments" : failure.path}: ${failure.message}`;
	}
}
