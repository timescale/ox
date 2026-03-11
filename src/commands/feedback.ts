// ============================================================================
// Feedback Command - Send product feedback to the ox team
// ============================================================================

import { Command } from 'commander';
import { sendFeedback } from '../services/feedback';

export async function feedbackAction(message: string): Promise<void> {
  if (!message || !message.trim()) {
    console.error('Error: Please provide a feedback message.');
    process.exit(1);
  }

  const result = await sendFeedback(message);

  if (result.success) {
    console.log('Thanks for your feedback!');
  } else {
    console.error(`Could not send feedback: ${result.error}`);
    process.exit(1);
  }
}

export const feedbackCommand = new Command('feedback')
  .description('Send product feedback to the ox team')
  .argument('<message>', 'Your feedback message')
  .action(feedbackAction);
