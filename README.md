# gemini-google-chat-application

Not for production.

Exploration of a Gemini chat app.

Code created with the help of Gemini.

This repository will not be maintained.

## About

This repository contains the code for a Google Chat bot that uses the Google Gemini API to answer questions and participate in conversations.

The bot can be added to Google Chat spaces or used in direct messages.

### Features

*   **Direct Messaging and @Mentions:** The bot will respond to all direct messages and any messages where it is @mentioned in a space.
*   **Conversation History:** The bot maintains a history of the conversation, allowing for follow-up questions and context.
*   **Slash Commands:** The bot supports the following slash commands:
    *   `/chat [your message]`: Start a conversation with the bot.
    *   `/pro [your message]`: Use the Gemini Pro model for more complex queries.
    *   `/newchat [your message]`: Start a new conversation, clearing the previous history.
    *   `/clearhistory`: Clear the conversation history.
    *   `/source`: Get a link to the bot's source code.
*   **Automatic History Clearing:** The bot will automatically clear the conversation history when it is removed from a space.

### Configuration

The bot is configured using script properties in the Google Apps Script editor. The following properties are required:

*   `GEMINI_API_KEY`: Your API key for the Gemini API.
*   `BOT_USER_ID`: The user ID of the bot.
*   `BOT_DISPLAY_NAME`: The display name of the bot.