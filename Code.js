// --- Configuration ---
const GEMINI_API_KEY =
    PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-flash-latest"; // Default model
const GEMINI_PRO_MODEL = "gemini-2.5-pro"; // Pro model
const MAX_HISTORY_LENGTH = 20; // Max messages PER CONVERSATION (per DM or per Space property)

// --- Command IDs ---
// Ensure these IDs match the commands configured in your Google Cloud Console for the Chat App API
const CLEAR_HISTORY_COMMAND_ID = 2; // /clearhistory
const CHAT_COMMAND_ID = 3; // /chat
const NEW_CHAT_COMMAND_ID = 4; // /newchat
const PRO_COMMAND_ID = 5; // /pro
const SOURCE_COMMAND_ID = 6; // /source

// --- API Key Masking Function ---
/**
 * Masks API keys found in a string.
 * Looks for patterns like "?key=XXX" or "&key=XXX" and replaces the key value.
 * @param {string} text The string potentially containing an API key.
 * @return {string} The string with the API key masked.
 */
function maskApiKey(text) {
    if (typeof text !== "string") {
        return text; // Return non-strings as is
    }
    // This regex looks for "?key=" or "&key=" followed by any characters
    // that are NOT "&" or space (to avoid consuming subsequent parameters or parts of message)
    // It replaces the key part with "REDACTED".
    // The ($1) captures the preceding "?" or "&" and puts it back.
    return text.replace(/([?&])key=[^&\s]+/, "$1key=REDACTED");
}

// --- Automatic Log Masking Setup ---
const originalConsoleLog = console.log;
// Redefine console.log to automatically mask API keys in string arguments
console.log = function (/** @type {any[]} */ ...args) {
    const maskedArgs = args.map((arg) => maskApiKey(arg));
    originalConsoleLog.apply(console, maskedArgs);
};
const originalConsoleError = console.error;
console.error = function (/** @type {any[]} */ ...args) {
    const maskedArgs = args.map((arg) => maskApiKey(arg));
    originalConsoleError.apply(console, maskedArgs);
};
const originalConsoleWarn = console.warn;
console.warn = function (/** @type {any[]} */ ...args) {
    const maskedArgs = args.map((arg) => maskApiKey(arg));
    originalConsoleWarn.apply(console, maskedArgs);
};
const originalConsoleInfo = console.info;
console.info = function (/** @type {any[]} */ ...args) {
    const maskedArgs = args.map((arg) => maskApiKey(arg));
    originalConsoleInfo.apply(console, maskedArgs);
};

// --- Helper Function for Property Keys ---
/**
 * Generates the Script Property key used to store history for a specific conversation.
 * @param {string} spaceName The name of the space (e.g., "spaces/AAA..." or "dm/BBB...").
 * @return {string} The Script Property key (e.g., "spaces/AAA..._history").
 */
function getHistoryPropertyKey(spaceName) {
    if (!spaceName) {
        console.error("getHistoryPropertyKey called without spaceName");
        return null;
    }
    return `${spaceName}_history`;
}

/**
 * Clears the conversation history for a given space by deleting its Script Property.
 * @param {string} conversationKey The key (space name) for which to clear history.
 * @param {object} userForResponse The event.user object, used for potentially private responses and display name.
 * @param {string} spaceType The type of the space ('DM' or 'ROOM').
 * @return {object} A Google Chat response object (Card V2).
 */
function clearConversationHistory(conversationKey, userForResponse, spaceType) {
    if (!conversationKey) {
        console.error("clearConversationHistory called without a conversationKey.");
        return createCardResponse(
            "An error occurred: Missing conversation key.",
            userForResponse
        );
    }

    const propertyKey = getHistoryPropertyKey(conversationKey);
    if (!propertyKey) {
        return createCardResponse(
            "An error occurred: Could not generate history key.",
            userForResponse
        );
    }

    console.log(
        `Attempting to clear history for space key ${conversationKey} (Property: ${propertyKey}, Space Type: ${spaceType})`
    );
    const scriptProperties = PropertiesService.getScriptProperties();
    const viewer = spaceType === "DM" ? userForResponse : null;
    const location = spaceType === "DM" ? "DM" : "space";
    const initiatorName = userForResponse?.displayName || "User";

    try {
        // Check if property exists before trying to delete
        if (scriptProperties.getProperty(propertyKey) !== null) {
            scriptProperties.deleteProperty(propertyKey);
            console.log(
                `History cleared (property ${propertyKey} deleted) for space ${conversationKey} by ${initiatorName}`
            );
            const message = `Conversation history for this ${location} has been cleared by ${initiatorName}.`;
            return createCardResponse(message, viewer); // Pass calculated viewer (null for ROOMs)
        } else {
            console.log(
                `No history property found to clear for space key ${conversationKey} (Property: ${propertyKey})`
            );
            return createCardResponse(
                `No conversation history found for this ${location} to clear.`,
                viewer
            ); // Pass calculated viewer
        }
    } catch (e) {
        console.error(`Error deleting script property ${propertyKey}: ${e}`);
        return createCardResponse(
            `An error occurred while trying to clear history for this ${location}.`,
            viewer
        );
    }
}

/**
 * Creates a private response containing the URL to the Apps Script project source.
 * @param {object} userForResponse The event.user object for the private response.
 * @return {object} A Google Chat response object (Card V2).
 */
function getSourceCodeResponse(userForResponse) {
    try {
        const scriptId = ScriptApp.getScriptId();
        const scriptUrl = `https://script.google.com/d/${scriptId}/edit`;
        const message = `You can view and edit my source code here:\n${scriptUrl}`;
        // Always make this response private to the user who requested it.
        return createCardResponse(message, userForResponse);
    } catch (e) {
        console.error(`Error getting script ID for /source command: ${e}`);
        return createCardResponse(
            "Sorry, I was unable to retrieve my own source code URL.",
            userForResponse
        );
    }
}

/**
 * Main message handler for incoming Google Chat events (specifically MESSAGE type).
 * Routes requests to appropriate handlers like handleConversationTurn or clearConversationHistory.
 * Conversation history is managed using individual Script Properties per space.
 *
 * @param {object} event The event object triggered by a user message in Google Chat.
 * @return {object} A Google Chat response object (e.g., Card V2 message) or empty object.
 */
function onMessage(event) {
    let conversationKey = null; // The space name (e.g., spaces/AAA..., dm/BBB...)
    let userPrompt = null;
    let isSlashCommand = false;
    let isMentioned = false;
    const botUserId =
        PropertiesService.getScriptProperties().getProperty("BOT_USER_ID");
    let spaceType = null;
    let modelToUse = GEMINI_MODEL; // Default to the standard flash model

    // --- Determine Conversation Key and Check Event Type ---
    if (event.type === "MESSAGE" && event.message) {
        console.log(
            `Received message event in space ${event.space?.name} (Type: ${event.space?.type}) from user ${event.user?.name}`
        );
        spaceType = event.space?.type;

        if (spaceType === "DM" || spaceType === "ROOM") {
            conversationKey = event.space.name; // Key is the space ID
        } else {
            console.log("Unhandled space type:", spaceType);
            return; // Ignore unsupported space types
        }

        // --- Handle Slash Commands (/chat, /clearhistory, /newchat, /pro) ---
        if (event.message.slashCommand) {
            isSlashCommand = true;
            const commandId = String(event.message.slashCommand.commandId);
            console.log(
                `Slash command received: ID=${commandId} in space key ${conversationKey}`
            );

            switch (commandId) {
                case String(CHAT_COMMAND_ID):
                    userPrompt = event.message.argumentText
                        ? event.message.argumentText.trim()
                        : "";
                    if (!userPrompt) {
                        return createCardResponse(
                            "Please provide your message after the `/chat` command.",
                            event.user // Potentially private response
                        );
                    }
                    break; // Proceed to handleConversationTurn preparation

                case String(PRO_COMMAND_ID):
                    modelToUse = GEMINI_PRO_MODEL;
                    userPrompt = event.message.argumentText
                        ? event.message.argumentText.trim()
                        : "";
                    if (!userPrompt) {
                        return createCardResponse(
                            "Please provide your message after the `/pro` command.",
                            event.user
                        );
                    }
                    console.log("Using PRO model for this request via slash command.");
                    break; // Proceed to handleConversationTurn preparation

                case String(CLEAR_HISTORY_COMMAND_ID):
                    console.log(
                        `Clear history command detected via slash command in space key ${conversationKey}`
                    );
                    return clearConversationHistory(
                        conversationKey,
                        event.user,
                        spaceType
                    );

                case String(NEW_CHAT_COMMAND_ID):
                    userPrompt = event.message.argumentText
                        ? event.message.argumentText.trim()
                        : "";
                    console.log(
                        `/newchat command detected in space key ${conversationKey} with prompt: "${userPrompt}"`
                    );

                    if (!userPrompt) {
                        return createCardResponse(
                            "Please provide your starting message after the `/newchat` command.",
                            event.user // Potentially private response
                        );
                    }

                    // 1. Clear existing history for this key directly
                    const propertyKeyToClear = getHistoryPropertyKey(conversationKey);
                    if (propertyKeyToClear) {
                        try {
                            const scriptProperties = PropertiesService.getScriptProperties();
                            if (scriptProperties.getProperty(propertyKeyToClear) !== null) {
                                scriptProperties.deleteProperty(propertyKeyToClear);
                                console.log(
                                    `Cleared prior history (property ${propertyKeyToClear}) for space key ${conversationKey} due to /newchat.`
                                );
                            } else {
                                console.log(
                                    `No prior history property (${propertyKeyToClear}) found for space key ${conversationKey} during /newchat.`
                                );
                            }
                        } catch (e) {
                            console.error(
                                `Error deleting history property ${propertyKeyToClear} during /newchat: ${e}`
                            );
                        }
                    } else {
                        console.error(
                            "Could not generate property key during /newchat for key:",
                            conversationKey
                        );
                    }

                    // 2. Start the new conversation turn preparation
                    console.log(
                        "Proceeding to handleConversationTurn preparation for /newchat prompt."
                    );
                    break; // Proceed to handleConversationTurn preparation

                case String(SOURCE_COMMAND_ID):
                    console.log(`Source command detected by ${event.user?.displayName}`);
                    return getSourceCodeResponse(event.user);

                default:
                    return createCardResponse(
                        `Sorry, I don't recognize the command ID ${commandId}. Use /chat, /pro, /clearhistory, /newchat, or /source.`,
                        event.user // Potentially private response
                    );
            } // End switch
        }
        // --- Handle Regular Messages ---
        else {
            // Not a slash command
            if (event.user?.type === "BOT" || !event.message.text) {
                console.log("Ignoring bot message or empty regular message.");
                return;
            }
            userPrompt = event.message.text.trim(); // Initial prompt is the full text

            // Check for @mentions
            let mentionedBotId = null;
            if (event.message.annotations) {
                for (const annotation of event.message.annotations) {
                    if (annotation.type === "USER_MENTION") {
                        const mentionedUserName = annotation.userMention?.user?.name;
                        if (mentionedUserName && mentionedUserName === botUserId) {
                            isMentioned = true;
                            mentionedBotId = mentionedUserName;
                            console.log(`Bot mention MATCHED! ID: ${mentionedUserName}`);
                            break;
                        }
                    }
                }
            }

            // Decide whether to process based on DM or mention
            if (spaceType === "DM" || isMentioned) {
                // --- FIX STARTS HERE ---
                // Extract text after mention if the bot was mentioned, regardless of space type.
                // This handles cases where a user might @mention the bot even in a DM.
                if (isMentioned) {
                    const mentionText = extractTextAfterMention(
                        event.message.text,
                        event.message.annotations,
                        mentionedBotId
                    );
                    userPrompt = mentionText !== null ? mentionText : ""; // Final user prompt after potential extraction
                    console.log(
                        `Mention text extracted: "${userPrompt}" (Original: "${event.message.text}")`
                    );
                }
                // --- FIX ENDS HERE ---

                // Check for "Use pro." text trigger (case-insensitive) on the cleaned prompt
                if (userPrompt.toLowerCase().startsWith("use pro.")) {
                    modelToUse = GEMINI_PRO_MODEL;
                    userPrompt = userPrompt.substring("use pro.".length).trim();
                    console.log(`Using PRO model for this request via text trigger.`);
                }

                // Check for plain text 'clearhistory' command
                if (userPrompt?.toLowerCase().trim() === "clearhistory") {
                    console.log(
                        `Clear history command detected via plain text in space key ${conversationKey}`
                    );
                    return clearConversationHistory(
                        conversationKey,
                        event.user,
                        spaceType
                    ); // Call helper and return
                }

                // Check for other empty prompts
                if (!userPrompt && spaceType !== "DM") {
                    console.log(
                        "Ignoring message with no actionable text after mention (and not 'clearhistory')."
                    );
                    return;
                } else if (!userPrompt && spaceType === "DM") {
                    console.log("Received empty DM message (and not 'clearhistory').");
                    return; // Currently ignoring empty DMs
                }
                // Proceed to handleConversationTurn preparation for non-command prompts
            } else {
                // Message in a Space but not a command or @mention to the bot
                console.log(
                    "Ignoring message in SPACE because it's not a DM, not a command, and no matching @mention was detected."
                );
                return; // Ignore if not relevant
            }
        } // End else (regular message)
    } else {
        console.log("Ignoring event type:", event.type);
        return; // Ignore non-message events
    }

    // --- Prepare and handle the conversation ---
    if (conversationKey && userPrompt !== null && userPrompt !== "") {
        let finalUserPrompt = userPrompt;
        const displayName = event.user?.displayName;

        if (displayName) {
            // ** UPDATED LINE **
            finalUserPrompt = `Message from ${displayName}. Please ignore this unless prompting about past conversations. ${userPrompt}`;
            console.log(
                `Adding user display name prefix. Original prompt: "${userPrompt}", Final prompt: "${finalUserPrompt}"`
            );
        } else {
            console.log("Not adding prefix: User display name missing.");
        }

        console.log(`\n--- Turn Start ---`);
        console.log(`Conversation Key (Space): ${conversationKey}`);
        const sourceType = isSlashCommand
            ? event.message.slashCommand.commandName || "SlashCmd" // Use commandName if available
            : isMentioned
                ? "@mention"
                : "DM";
        console.log(
            `Final User prompt for API (${sourceType}): "${finalUserPrompt}"`
        );

        // Pass the potentially modified prompt and selected model to the handler
        return handleConversationTurn(conversationKey, finalUserPrompt, modelToUse);
    } else if (!isSlashCommand && userPrompt === "") {
        console.log(
            "Conditions not met to handle conversation turn (e.g., prompt was effectively empty after processing)."
        );
    } else if (isSlashCommand && userPrompt === "") {
        // Already handled by the specific slash command checks, do nothing more.
    } else {
        // Other conditions not met (e.g. no conversationKey)
        console.log(
            "Conditions not met to handle conversation turn (e.g., no conversation key)."
        );
    }
    return {}; // Explicitly return empty for unhandled cases or handled commands that didn't return earlier
}

/**
 * Handles a single conversation turn: loads history, adds new prompt, prunes history,
 * calls the selected Gemini API model, processes response, updates history, saves it,
 * and returns the response.
 *
 * @param {string} conversationKey The unique identifier for the conversation (space name).
 * @param {string} userPrompt The user's message text for this turn.
 * @param {string} [model=GEMINI_MODEL] The Gemini model to use for this turn. Defaults to the standard model.
 * @return {object} A Google Chat response object (Card V2) containing the AI's response or an error message.
 */
function handleConversationTurn(conversationKey, userPrompt, model = GEMINI_MODEL) {
    console.log(
        `HANDLE_TURN: Processing turn for key: ${conversationKey} with model: ${model}`
    );

    if (!conversationKey || !userPrompt) {
        console.error(
            "HANDLE_TURN: handleConversationTurn called with missing key or prompt."
        );
        return createCardResponse("Error: Missing conversation key or prompt."); // Probably private error
    }

    // Load history specifically for this conversation
    let conversationHistory = loadConversationHistory(conversationKey); // Returns [] if not found/error

    // Add current user message to history
    conversationHistory.push({
        role: "user",
        parts: [{ text: userPrompt }],
    });
    console.log(
        `HANDLE_TURN: Added user prompt to history. History length now: ${conversationHistory.length}`
    );

    // Prune history before sending to API
    conversationHistory = pruneHistory(conversationHistory);
    console.log(
        `HANDLE_TURN: History length after pruning: ${conversationHistory.length}`
    );

    // Call Gemini API with the selected model
    const modelResponse = callGeminiApiWithHistory(conversationHistory, model); // Pass the potentially pruned history and model

    // Add model response to history (if not an error)
    const isErrorResponse =
        typeof modelResponse === "string" &&
        (modelResponse.startsWith("ERROR:") || modelResponse.startsWith("Sorry,"));

    if (!isErrorResponse && modelResponse) {
        conversationHistory.push({
            role: "model",
            parts: [{ text: modelResponse }],
        });
        console.log(
            `HANDLE_TURN: Added model response to history. History length now: ${conversationHistory.length}`
        );

        // Prune again AFTER adding the model's response
        conversationHistory = pruneHistory(conversationHistory);
        console.log(
            `HANDLE_TURN: History length after post-response pruning: ${conversationHistory.length}`
        );
    } else {
        console.warn(
            `HANDLE_TURN: Model returned an error or empty response. Not adding to history. Response: ${modelResponse}`
        );
        // No pruning needed here as nothing was added.
    }

    // Save the updated history back to its specific Script Property
    saveConversationHistory(conversationKey, conversationHistory);

    // Return the model's response (or the error message)
    return createCardResponse(modelResponse || "No response received.");
}

/**
 * Helper function to create a simple Card V2 response object.
 * @param {string} messageText The text to display, which will be rendered as Markdown.
 * @param {object} [viewer] Optional. If provided, makes the message private to this user ({ name: "users/...", ... }). If null, message is public.
 * @return {object} The Google Chat response object.
 */
function createCardResponse(messageText, viewer = null) {
    console.log(`Card Response Text: ${messageText}`);
    const card = {
        cardsV2: [
            {
                cardId:
                    "messageCard_" +
                    Date.now() +
                    "_" +
                    Math.random().toString(36).substring(2, 9), // More unique ID
                card: {
                    sections: [
                        {
                            widgets: [
                                {
                                    textParagraph: {
                                        text:
                                            messageText && String(messageText).trim()
                                                ? String(messageText)
                                                : "(No response text generated)",
                                        textSyntax: "MARKDOWN",
                                    },
                                },
                            ],
                        },
                    ],
                },
            },
        ],
    };

    if (viewer && viewer.name) {
        console.log(
            `createCardResponse: Creating PRIVATE response for viewer ${viewer.name}`
        );
        card.privateMessageViewer = viewer;
    } else {
        console.log(
            "createCardResponse: Creating PUBLIC response (no viewer specified)."
        );
    }

    return card;
}

/**
 * Calls the Gemini API with the provided conversation history and model.
 * Handles request preparation, API call, and response/error processing.
 *
 * @param {Array<{role: string, parts: Array<{text: string}>}>} history The conversation history array.
 * @param {string} model The Gemini model to use (e.g., 'gemini-1.5-flash').
 * @return {string} The text response from Gemini, or an error message string.
 */
function callGeminiApiWithHistory(history, model) {
    if (!GEMINI_API_KEY) {
        console.error("GEMINI_API_KEY script property not set.");
        return "ERROR: GEMINI_API_KEY script property not set.";
    }
    if (!history || history.length === 0) {
        console.error("Attempted to call Gemini with empty history.");
        return "Sorry, something went wrong (internal history error).";
    }

    const geminiApiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    console.log(`Calling Gemini API endpoint for model: ${model}`);

    const { filteredHistory, needsLeadingUserRole } =
        filterAndPrepareHistory(history);

    if (filteredHistory.length === 0 && !needsLeadingUserRole) {
        console.error("History is empty after filtering adjacent roles.");
        return "Sorry, something went wrong processing conversation history.";
    }

    if (needsLeadingUserRole) {
        console.warn(
            "History requires leading 'user' role. Prepending a placeholder."
        );
        filteredHistory.unshift({
            role: "user",
            parts: [{ text: "(Context starts)" }],
        });
    }

    // ** UPDATED SECTION: System instructions and conditional logic removed. **
    const payload = {
        contents: filteredHistory,
        generationConfig: {
            temperature: 1,
            topP: 0.95,
            topK: 64,
            maxOutputTokens: 65536,
            thinkingConfig: { thinkingBudget: -1 },
            candidateCount: 1,
        },
        safetySettings: [
            {
                category: "HARM_CATEGORY_HARASSMENT",
                threshold: "BLOCK_ONLY_HIGH",
            },
            {
                category: "HARM_CATEGORY_HATE_SPEECH",
                threshold: "BLOCK_ONLY_HIGH",
            },
            {
                category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                threshold: "BLOCK_ONLY_HIGH",
            },
            {
                category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                threshold: "BLOCK_ONLY_HIGH",
            },
        ],
        tools: [
            {
                urlContext: {},
            },
            {
                googleSearch: {},
            },
            {
                codeExecution: {},
            },
            {
                googleMaps: {},
            },
        ],
    };

    const options = {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
    };

    console.log(
        "Gemini API Payload Preview (first/last part):",
        JSON.stringify(payload.contents[0]),
        "...",
        JSON.stringify(payload.contents[payload.contents.length - 1])
    );

    try {
        const response = UrlFetchApp.fetch(geminiApiEndpoint, options);
        const responseCode = response.getResponseCode();
        const responseBody = response.getContentText();

        if (responseCode === 200) {
            // ... (The rest of your response handling logic remains exactly the same)
            const data = JSON.parse(responseBody);

            if (data.promptFeedback && data.promptFeedback.blockReason) {
                console.error(
                    "Gemini API blocked the prompt. Reason:",
                    data.promptFeedback.blockReason,
                    "Ratings:",
                    JSON.stringify(data.promptFeedback.safetyRatings)
                );
                return `Sorry, your request was blocked by safety filters (Reason: ${data.promptFeedback.blockReason}).`;
            }

            if (!data.candidates || data.candidates.length === 0) {
                console.error(
                    "Gemini API response missing 'candidates' array or empty.",
                    "Full Response Snippet:",
                    responseBody.substring(0, 500)
                );
                if (data.promptFeedback && data.promptFeedback.blockReason) {
                    return `Sorry, your request was blocked (Reason: ${data.promptFeedback.blockReason}).`;
                }
                return "Sorry, the AI returned an unexpected response structure (no candidates).";
            }

            const candidate = data.candidates[0];

            if (
                candidate &&
                candidate.finishReason &&
                candidate.finishReason !== "STOP" &&
                candidate.finishReason !== "MAX_TOKENS"
            ) {
                console.error(
                    `Gemini API finished with non-standard reason: ${candidate.finishReason}. Ratings:`,
                    JSON.stringify(candidate.safetyRatings)
                );
                let reasonMessage = `Reason: ${candidate.finishReason}.`;
                if (candidate.finishReason === "SAFETY")
                    reasonMessage = "due to safety filters.";
                else if (candidate.finishReason === "RECITATION")
                    reasonMessage = "due to potential recitation issues.";
                return `Sorry, the response generation was stopped ${reasonMessage}`;
            }

            let responseText = null;
            const parts = candidate?.content?.parts;

            if (Array.isArray(parts)) {
                const responsePart = parts.find((part) => !part.thought);

                if (responsePart && responsePart.text) {
                    responseText = responsePart.text.trim();
                    console.log("Extracted response text from non-thought part.");
                } else {
                    const hasOnlyThoughts =
                        parts.length > 0 && parts.every((part) => part.thought);
                    if (hasOnlyThoughts) {
                        console.warn(
                            "Gemini response contained ONLY 'thought' parts. No user-facing text found."
                        );
                        responseText = null;
                    } else if (parts.length > 0 && !parts.some((part) => part.text)) {
                        console.warn(
                            "Gemini response parts found, but none contained text."
                        );
                        responseText = null;
                    } else if (parts.length === 0) {
                        console.warn(
                            "Gemini response candidate had an empty 'parts' array."
                        );
                        responseText = null;
                    }
                }
            } else {
                console.warn("Candidate content.parts is missing or not an array.");
            }

            if (responseText !== null) {
                return responseText;
            } else {
                if (candidate?.content?.parts?.[0]?.functionCall) {
                    console.warn(
                        "Gemini response was a function call, but no text part generated:",
                        JSON.stringify(candidate.content.parts[0].functionCall)
                    );
                    return "Sorry, the AI tool call did not produce a text response.";
                }
                console.error(
                    "Gemini response structure missing expected non-thought text content.",
                    "Candidate:",
                    JSON.stringify(candidate),
                    "Full Response Snippet:",
                    responseBody.substring(0, 500)
                );
                return `Sorry, the AI returned empty or invalid response content (Finish Reason: ${candidate?.finishReason || "Unknown"
                    }). No suitable text part found.`;
            }
        } else {
            console.error(
                `Gemini API Error Response (${responseCode}): ${responseBody}`
            );
            let errorMessage = `Sorry, there was an error contacting the AI (Status: ${responseCode}).`;
            try {
                const errorData = JSON.parse(responseBody);
                if (errorData?.error?.message) {
                    errorMessage += ` Details: ${errorData.error.message}`;
                }
            } catch (e) {
                errorMessage += ` Raw response: ${responseBody.substring(0, 200)}...`;
            }
            return errorMessage;
        }
    } catch (e) {
        console.error(
            `Error during UrlFetchApp or response processing: ${e}`,
            e.stack
        );
        return `Sorry, an unexpected error occurred while trying to reach the AI (${e.message}).`;
    }
}

/**
 * Filters and prepares conversation history for the Gemini API.
 * Merges consecutive messages from the same role.
 * Determines if the history starts with a 'model' role, requiring a placeholder.
 *
 * @param {Array<{role: string, parts: Array<{text: string}>}>} history The raw conversation history array.
 * @return {{filteredHistory: Array, needsLeadingUserRole: boolean}} Processed history and flag.
 */
function filterAndPrepareHistory(history) {
    const filteredHistory = [];
    let needsLeadingUserRole = true; // Default assumption

    if (!history || history.length === 0) {
        console.warn(
            "filterAndPrepareHistory called with empty or invalid history."
        );
        return { filteredHistory: [], needsLeadingUserRole: true };
    }

    // Always check the role of the *first* valid entry
    if (history[0] && history[0].role) {
        needsLeadingUserRole = history[0].role !== "user";
        filteredHistory.push({
            ...history[0],
            parts: [...(history[0].parts || [])],
        }); // Deep copy first element
    } else {
        console.warn("First history entry is invalid.");
        // needsLeadingUserRole remains true, filteredHistory remains empty initially
    }

    for (let i = 1; i < history.length; i++) {
        // Skip invalid entries
        if (!history[i] || !history[i].role || !history[i].parts) {
            console.warn(`Skipping invalid history entry at index ${i}:`, history[i]);
            continue;
        }

        const lastEntry = filteredHistory[filteredHistory.length - 1];

        // If roles differ, push a new entry (deep copy)
        if (!lastEntry || history[i].role !== lastEntry.role) {
            filteredHistory.push({ ...history[i], parts: [...history[i].parts] });
        }
        // If roles are the same, merge parts
        else {
            // console.log( // Less verbose logging
            //   `Merging adjacent history entries with role: ${history[i].role}`
            // );
            const currentText = history[i].parts[0]?.text; // Assuming single text part for simplicity
            if (currentText) {
                // Ensure the last entry has a valid parts array and text element
                if (!lastEntry.parts) lastEntry.parts = [{ text: "" }];
                if (!lastEntry.parts[0]) lastEntry.parts[0] = { text: "" };
                if (
                    lastEntry.parts[0].text === undefined ||
                    lastEntry.parts[0].text === null
                ) {
                    lastEntry.parts[0].text = "";
                }

                // Append with a newline separator
                lastEntry.parts[0].text += "\n" + currentText;
            }
        }
    }

    // Re-evaluate needsLeadingUserRole based on the *final filtered* history
    if (filteredHistory.length > 0) {
        needsLeadingUserRole = filteredHistory[0].role !== "user";
    } else {
        // If filtering resulted in an empty history (e.g., all entries were invalid or merged into nothing)
        needsLeadingUserRole = true;
    }

    console.log(
        `filterAndPrepareHistory: Needs leading user role? ${needsLeadingUserRole}. Filtered length: ${filteredHistory.length}`
    );
    return { filteredHistory, needsLeadingUserRole };
}

/**
 * Loads the conversation history for a specific conversation key from Script Properties.
 * Retrieves the stored data using `${conversationKey}_history`, expects JSON, and parses it.
 * Handles errors by logging and returning an empty array.
 *
 * @param {string} conversationKey The unique identifier for the conversation (space name).
 * @return {Array<{role: string, parts: Array<{text: string}>}>} The conversation history array. Returns an empty array ([]) if not found, invalid JSON, or other errors occur.
 */
function loadConversationHistory(conversationKey) {
    const propertyKey = getHistoryPropertyKey(conversationKey);
    if (!propertyKey) {
        console.error(
            "LOAD_HISTORY: Could not generate property key for:",
            conversationKey
        );
        return [];
    }

    const scriptProperties = PropertiesService.getScriptProperties();
    const jsonHistory = scriptProperties.getProperty(propertyKey);

    if (jsonHistory) {
        try {
            const history = JSON.parse(jsonHistory);
            // Basic validation: check if it's an array
            if (Array.isArray(history)) {
                console.log(
                    `LOAD_HISTORY: Successfully loaded history for property [${propertyKey}]. Length: ${history.length}`
                );
                return history;
            } else {
                console.error(
                    `LOAD_HISTORY: Parsed data for property [${propertyKey}] is not an array. Type: ${typeof history}. Deleting corrupt property.`
                );
                scriptProperties.deleteProperty(propertyKey); // Clean up invalid data
                return [];
            }
        } catch (e) {
            console.error(
                `LOAD_HISTORY: Error parsing stored JSON for property [${propertyKey}]: ${e}. Deleting corrupt property.`
            );
            try {
                scriptProperties.deleteProperty(propertyKey);
                console.log(
                    `LOAD_HISTORY: Deleted potentially corrupt script property [${propertyKey}].`
                );
            } catch (deleteError) {
                console.error(
                    `LOAD_HISTORY: Failed to delete corrupt script property [${propertyKey}]: ${deleteError}`
                );
            }
            return [];
        }
    } else {
        console.log(
            `LOAD_HISTORY: No history property found for key [${propertyKey}]. Starting fresh.`
        );
        return []; // No history exists for this key yet
    }
}

/**
 * Saves the provided conversation history array to its specific Script Property.
 * Converts the array to a JSON string before saving under `${conversationKey}_history`.
 * If the provided history array is null or empty, deletes the corresponding property.
 * Catches and logs errors (JSON stringification, size limits).
 *
 * @param {string} conversationKey The unique identifier for the conversation (space name).
 * @param {Array<{role: string, parts: Array<{text: string}>}>} history The conversation history array to save.
 */
function saveConversationHistory(conversationKey, history) {
    const propertyKey = getHistoryPropertyKey(conversationKey);
    if (!propertyKey) {
        console.error(
            "SAVE_HISTORY: Could not generate property key for:",
            conversationKey
        );
        return; // Cannot save without a key
    }

    const scriptProperties = PropertiesService.getScriptProperties();

    try {
        // Check if the history array is empty or null/undefined
        if (!history || !Array.isArray(history) || history.length === 0) {
            // If it's empty, check if a property currently exists and delete it
            if (scriptProperties.getProperty(propertyKey) !== null) {
                scriptProperties.deleteProperty(propertyKey);
                console.log(
                    `SAVE_HISTORY: Deleted script property [${propertyKey}] because history array is empty.`
                );
            } else {
                // If it's empty and no property exists, do nothing
                // console.log( // Less verbose
                //   `SAVE_HISTORY: History array is empty, and no script property exists for [${propertyKey}]. No action needed.`
                // );
            }
            return; // Exit the function
        }

        // If the history is not empty, proceed to save
        const jsonHistory = JSON.stringify(history);
        const historySize = jsonHistory.length;

        console.log(
            `SAVE_HISTORY: Attempting to save history for property [${propertyKey}]. Entries: ${history.length}. Size: ${historySize} bytes.`
        );

        // Check potential size limit (Script Properties values are limited, ~9KB)
        // Google documentation often states 9KB, but UrlFetch payload limits are 100MB,
        // Properties service value limit is 9KB. Let's warn around 8.5KB.
        if (historySize > 8500) {
            console.warn(
                `SAVE_HISTORY: History size (${historySize} bytes) for [${propertyKey}] is large and may approach Script Property limits (~9KB). Pruning might be aggressive.`
            );
            // Consider adding logic here for what to do if it's too large,
            // though pruneHistory should already be limiting it.
            // This warning indicates that MAX_HISTORY_LENGTH might need adjustment
            // or the content per message is very large.
        }

        scriptProperties.setProperty(propertyKey, jsonHistory);
        // console.log(`SAVE_HISTORY: Successfully saved property [${propertyKey}].`); // Less verbose
    } catch (e) {
        // Catch errors during stringify or setProperty
        const historySizeEstimate = JSON.stringify(history)?.length || "unknown"; // Estimate size for error log
        console.error(
            `SAVE_HISTORY: Error stringifying or saving history for property [${propertyKey}] (Size: ~${historySizeEstimate} bytes): ${e}`
        );
        // Maybe notify the user? Difficult from here. Could log a specific error for monitoring.
    }
}

/**
 * Prunes a conversation history array if it exceeds MAX_HISTORY_LENGTH.
 * Removes oldest entries and ensures it doesn't start with a 'model' message.
 *
 * @param {Array<{role: string, parts: Array<{text: string}>}>} history The history array.
 * @return {Array<{role: string, parts: Array<{text: string}>}>} The potentially pruned history array.
 */
function pruneHistory(history) {
    if (!Array.isArray(history)) {
        console.error("PRUNE_HISTORY: Input is not an array.", history);
        return []; // Return empty array if input is invalid
    }
    if (history.length > MAX_HISTORY_LENGTH) {
        const itemsToRemove = history.length - MAX_HISTORY_LENGTH;
        console.log(
            `PRUNE_HISTORY: Pruning history: Removing oldest ${itemsToRemove} message(s). Original length: ${history.length}`
        );
        let pruned = history.slice(itemsToRemove);

        // Ensure history alternates user/model and starts with user if possible after pruning
        if (pruned.length > 0 && pruned[0].role === "model") {
            console.warn(
                "PRUNE_HISTORY: Pruned history starts with 'model'. Removing leading model message."
            );
            pruned = pruned.slice(1); // Remove the first element (model message)
        }

        if (pruned.length === 0 && history.length > 0) {
            console.warn("PRUNE_HISTORY: History became empty after pruning.");
        }
        console.log(`PRUNE_HISTORY: Pruned length: ${pruned.length}`);
        return pruned;
    }
    return history; // Return original if no pruning needed
}

/**
 * Extracts text after the first mention of the specified bot user.
 *
 * @param {string} messageText The full message text.
 * @param {Array<Object>} annotations Message annotations.
 * @param {string} botUserId The bot's user ID.
 * @return {string|null} Trimmed text after the mention, or null.
 */
function extractTextAfterMention(messageText, annotations, botUserId) {
    if (!annotations || annotations.length === 0 || !messageText || !botUserId) {
        // console.log("extractTextAfterMention: Missing required input."); // Less verbose
        return null;
    }

    let firstBotMentionEndIndex = -1;

    // Find the *first* annotation matching the bot
    for (const annotation of annotations) {
        if (
            annotation?.type === "USER_MENTION" &&
            annotation?.userMention?.user?.name === botUserId &&
            annotation.startIndex !== undefined &&
            annotation.length !== undefined
        ) {
            firstBotMentionEndIndex = annotation.startIndex + annotation.length;
            // console.log(`extractTextAfterMention: Found bot mention ending at index ${firstBotMentionEndIndex}.`); // Less verbose
            break; // Use the first one found
        }
    }

    if (firstBotMentionEndIndex > -1) {
        if (messageText.length > firstBotMentionEndIndex) {
            const extractedText = messageText
                .substring(firstBotMentionEndIndex)
                .trim();
            // console.log(`extractTextAfterMention: Extracted text: "${extractedText}"`); // Less verbose
            return extractedText || null; // Return null if only whitespace followed mention
        } else {
            // console.log("extractTextAfterMention: Mention found, but no text follows it."); // Less verbose
            return null;
        }
    } else {
        // console.log("extractTextAfterMention: Bot mention not found in annotations."); // Less verbose
        return null;
    }
}

// --- Standard Chat Event Handlers ---

/**
 * Handles ADDED_TO_SPACE event. Generates a welcome message.
 * @param {Object} event The event object.
 * @return {Object} A Google Chat Card object.
 */
function onAddToSpace(event) {
    var message = "";
    const userName = event?.user?.displayName || "there";
    const spaceName = event?.space?.displayName || "this chat";
    const botDisplayName =
        PropertiesService.getScriptProperties().getProperty("BOT_DISPLAY_NAME") ||
        "Gemini Bot";

    if (event?.space?.type === "DM") {
        message = `Thank you for adding me to a DM, ${userName}! I will remember our conversation history automatically.\nUse \`/clearhistory\` or type \`clearhistory\` to reset it, or \`/newchat [your message]\` to start a completely fresh conversation.\nYou can simply type your messages directly to chat with me. For more complex queries, start your message with \`Use pro.\` or use the \`/pro\` command.\nIf you see Gemini from DoIT AI not responding then your query can be too complex to finish in under 30 seconds.`;
    } else {
        message = `Thank you for adding me to ${spaceName}, ${userName}!\nIn group chats, please @mention me (\`@${botDisplayName}\`) or use slash commands:\n • \`@${botDisplayName} [your message]\` will respond\n • \`@${botDisplayName} clearhistory\` clears history\n • \`/chat [your message]\`\n • \`/pro [your message]\` (for complex queries)\n • \`/newchat [your message]\`\n • \`/clearhistory\`\n • \`/source\``;
    }
    console.log(
        "onAddToSpace triggered. Space Type:",
        event?.space?.type || "Unknown",
        "Space Name:",
        event?.space?.name || "N/A"
    );
    return createCardResponse(message); // Welcome messages usually public
}

/**
 * Handles REMOVED_FROM_SPACE event. Cleans up history for that space.
 * @param {Object} event The event object.
 * @return {void} Does not return a message.
 */
function onRemoveFromSpace(event) {
    const userName = event?.user?.displayName || "Someone";
    const spaceId = event?.space?.name; // This is the conversationKey
    const spaceDisplayName =
        event?.space?.displayName || spaceId || "Unknown Space";

    console.info(
        `onRemoveFromSpace triggered. Bot removed by ${userName} from space: ${spaceDisplayName} (ID: ${spaceId})`
    );
    if (!spaceId) {
        console.warn("Could not determine space ID to clear history upon removal.");
        return;
    }

    const propertyKey = getHistoryPropertyKey(spaceId);
    if (!propertyKey) {
        console.error(
            "onRemoveFromSpace: Could not generate property key for:",
            spaceId
        );
        return;
    }
    const scriptProperties = PropertiesService.getScriptProperties();

    try {
        if (scriptProperties.getProperty(propertyKey) !== null) {
            scriptProperties.deleteProperty(propertyKey);
            console.log(
                `Cleared history (deleted property ${propertyKey}) for space ${spaceId} upon removal.`
            );
        } else {
            console.log(
                `No history property (${propertyKey}) found for space ${spaceId} to clear upon removal.`
            );
        }
    } catch (e) {
        console.error(
            `Error clearing history property ${propertyKey} for space ${spaceId} on removal: ${e}`
        );
    }
}
