import type { MessageBlock } from "@rakazo/contracts";

type MentionBot = { id: string; name: string; color?: string };

/** Presentation metadata only. Call with authorized, resolved send targets, never client names.
 * Only the leading recipient list is recognized; prose, email and code remain literal text.
 */
export function withMessageMentions(
  blocks: MessageBlock[],
  bots: MentionBot[],
  everyone = false,
): MessageBlock[] {
  const candidates = bots
    .filter(
      (bot) =>
        bots.filter((other) => other.name.toLowerCase() === bot.name.toLowerCase()).length === 1,
    )
    .map((bot) => ({ kind: "bot" as const, id: bot.id, name: bot.name, color: bot.color }));
  const targets: Array<{ kind: "bot" | "everyone"; id: string; name: string; color?: string }> = [
    ...candidates,
    ...(everyone ? [{ kind: "everyone" as const, id: "everyone", name: "everyone" }] : []),
  ].sort((a, b) => b.name.length - a.name.length);
  return blocks.map((block) => {
    if (block.kind !== "text") return block;
    const mentions = [];
    let offset = 0;
    while (offset < block.text.length) {
      const whitespace = /^[ \t]*/.exec(block.text.slice(offset))![0];
      offset += whitespace.length;
      const matches = targets.filter((target) => {
        const token = `@${target.name}`;
        return (
          block.text.slice(offset, offset + token.length).toLowerCase() === token.toLowerCase() &&
          (offset + token.length === block.text.length ||
            /\s/.test(block.text[offset + token.length]!))
        );
      });
      const target = matches[0];
      if (!target) break;
      const end = offset + target.name.length + 1;
      mentions.push({ ...target, start: offset, end });
      offset = end;
    }
    return { ...block, mentions };
  });
}
