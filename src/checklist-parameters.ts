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

export type Action = "create" | "add" | "update" | "dismiss" | "replace" | "ack" | "list";

export class ChecklistParameters {
	private readonly actions: Record<Action, TObject>;
	private readonly fields: Record<Action, string[]>;
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
			reason: Type.String({ minLength: 1, maxLength: 2000 }),
			anchorId: Type.String({ minLength: 1, maxLength: 100 }),
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
			dismiss: {
				checklistId: fields.checklistId,
				revision: fields.revision,
				reason: fields.reason,
				anchorId: fields.anchorId,
				taskId: Type.Optional(fields.taskId),
			},
			replace: {
				checklistId: fields.checklistId,
				revision: fields.revision,
				reason: fields.reason,
				anchorId: fields.anchorId,
				title: fields.title,
				tasks: fields.tasks,
			},
			ack: { checklistId: fields.checklistId, revision: fields.revision, summary: fields.summary },
			list: {},
		};
		const names = Object.keys(actionFields) as Action[];
		this.fields = Object.fromEntries(
			names.map((action) => [action, Object.keys(actionFields[action])]),
		) as Record<Action, string[]>;
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

	public invalid(action: string, schema: TObject, params: Record<string, unknown>): string | null {
		const accepted = this.fields[action as Action] ?? [];
		const unexpected = Object.keys(params).filter(
			(name) => name !== "action" && !accepted.includes(name),
		);
		if (unexpected.length > 0) {
			const names = unexpected.map((name) => `"${name}"`).join(", ");
			const verb = unexpected.length === 1 ? "is" : "are";
			return `${names} ${verb} not accepted by action "${action}"`;
		}
		const [failure] = Value.Errors(schema, params);
		if (!failure) return null;
		return `${failure.path === "" ? "arguments" : failure.path}: ${failure.message}`;
	}
}
