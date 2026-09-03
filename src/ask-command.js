import { askGemini, describeAskError, getAskOptions } from './ask.js';
import { deadlineSignal, raceWithSignal } from './cancellation.js';
import {
  ASK_ALLOWED_MENTIONS, beginAskTtsRequest, buildAskEmbed,
  finishAskTtsRequest, queueAskAnswerTts, setAskStopButtonState
} from './ask-response.js';

async function editAnswer(interaction, payload) {
  const deadline = deadlineSignal(null, 10_000, new Error('Discord answer update timed out.'));
  try { return await raceWithSignal(interaction.editReply(payload), deadline.signal); }
  finally { deadline.cleanup(); }
}

export async function executeAskRequest(interaction, {
  options = getAskOptions(), ttsDependencies, ask = askGemini, queueTts = queueAskAnswerTts
}) {
  const question = interaction.options.getString('question', true);
  const controller = new AbortController();
  let sequence = null;
  await interaction.deferReply();
  let answer;
  let reply;
  try {
    ({ answer } = await ask(question, {
      options, signal: controller.signal,
      onAccepted() {
        sequence = beginAskTtsRequest(interaction.guildId, interaction.user.id, { controller });
        ttsDependencies.cancelSupersededAsk?.(interaction.guildId, interaction.user.id, sequence);
      }
    }));
    reply = await editAnswer(interaction, {
      content: null, embeds: [buildAskEmbed(interaction, question, answer)],
      allowedMentions: ASK_ALLOWED_MENTIONS
    });
  } catch (error) {
    finishAskTtsRequest(interaction.guildId, interaction.user.id, sequence);
    console.warn('[ask]', error?.code || error?.name || 'error', error?.status || '');
    await editAnswer(interaction, { content: describeAskError(error), embeds: [], allowedMentions: ASK_ALLOWED_MENTIONS }).catch(() => {});
    return;
  }
  // The visible text is final before any voice work is admitted. Bind speech
  // to the real Discord reply as well as its owner-only STOP control.
  void queueTts(interaction, answer, ttsDependencies, {
    requestSequence: sequence, replyMessageId: reply?.id ?? null
  }).catch((error) => {
    finishAskTtsRequest(interaction.guildId, interaction.user.id, sequence);
    void setAskStopButtonState(interaction, 'unavailable');
    console.warn('[ask-tts]', error?.code || error?.name || 'error');
  });
}
