from pathlib import Path

path = Path('test/ask-command.test.js')
text = path.read_text(encoding='utf-8')
old = "  const detachedTts = commandsSource.indexOf('void queueAskAnswerTts(interaction, answer, askTtsDependencies)');\n"
new = "  const detachedTts = commandsSource.indexOf('void queueAskAnswerTts(interaction, answer, askTtsDependencies, { requestSequence: askTtsSequence })');\n"
if text.count(old) != 1:
    raise RuntimeError(f'expected one detached TTS characterization anchor, found {text.count(old)}')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('Aligned /ask detached-TTS characterization with request sequencing.')
