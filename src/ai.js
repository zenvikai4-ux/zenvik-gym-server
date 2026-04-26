const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const ZENVIK_CONTEXT = `
You are a helpful assistant for ${process.env.ZENVIK_BUSINESS_NAME || 'Zenvik AI'}, a gym management software company.
Website: ${process.env.ZENVIK_WEBSITE || 'https://zenvikai.com'}
Services: ${process.env.ZENVIK_SERVICES || 'Gym Management Software, WhatsApp Automation, Lead Management, Member Tracking, Diet Plans'}
Contact: ${process.env.ZENVIK_CONTACT_EMAIL || ''}

Your job:
1. Answer questions about our gym management software
2. If someone is interested, collect their name, gym name, and best contact time
3. If it requires human attention (complaints, payments, urgent), say so clearly
4. Keep responses short, friendly, and professional (max 3 sentences)
5. Always respond in the same language the customer used
6. Never make up pricing - say "our team will share details"
`;

/**
 * Generate smart auto-reply using Groq (free tier)
 */
async function generateZenvikReply(customerMessage, customerName = 'there') {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',  // Free on Groq
      max_tokens: 200,
      messages: [
        { role: 'system', content: ZENVIK_CONTEXT },
        { role: 'user', content: `Customer message from ${customerName}: "${customerMessage}"` },
      ],
    });
    return completion.choices[0].message.content;
  } catch (err) {
    console.error('Groq reply failed:', err.message);
    return `Hi! Thanks for reaching out to ${process.env.ZENVIK_BUSINESS_NAME || 'Zenvik AI'}. We've received your message and will get back to you shortly. Visit us at ${process.env.ZENVIK_WEBSITE || 'https://zenvikai.com'} to learn more.`;
  }
}

/**
 * Check if message needs human attention
 */
async function needsHumanAttention(message) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 5,
      messages: [
        {
          role: 'system',
          content: 'Reply only "yes" or "no". Does this message require urgent human attention, express frustration, mention payment issues, or request something complex?'
        },
        { role: 'user', content: message },
      ],
    });
    return completion.choices[0].message.content.toLowerCase().includes('yes');
  } catch {
    return false;
  }
}

/**
 * Generate gym auto-reply (no AI needed - just template)
 */
function generateGymAutoReply(gymName, gymCustomReply) {
  if (gymCustomReply) return gymCustomReply;
  return `Hi! 👋 Thanks for reaching out to *${gymName}*.\n\nWe've received your message and will get back to you shortly.\n\nFor quick info about our gym, feel free to ask!\n\n_Powered by Zenvik AI_ 🤖`;
}

module.exports = { generateZenvikReply, needsHumanAttention, generateGymAutoReply };
