import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";

dotenv.config();

// Replace with your bot token from BotFather
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

// Supabase database connection
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN environment variable is required!");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("DATABASE_URL environment variable is required!");
  process.exit(1);
}

// Use webhook for production, polling for development
const useWebhook = process.env.NODE_ENV === "production";

let bot;
if (useWebhook) {
  // Production: Use webhook
  bot = new TelegramBot(BOT_TOKEN);
  bot.setWebHook(`${process.env.RENDER_EXTERNAL_URL}/bot${BOT_TOKEN}`);
} else {
  // Development: Use polling
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
}

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

console.log("Bot token loaded:", BOT_TOKEN ? "✓" : "✗");
console.log("Bot initialized:", bot ? "✓" : "✓");
console.log("Database connection:", DATABASE_URL ? "✓" : "✗");
console.log("Using webhook:", useWebhook);

// Test database connection
pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("Database connection error:", err);
  } else {
    console.log("Database connected successfully at:", res.rows[0].now);
  }
});

// Helper function to check if user is admin of a group
async function isGroupAdmin(groupId, userId) {
  try {
    const member = await bot.getChatMember(groupId, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch (error) {
    return false;
  }
}

// Helper function to get group info
async function getGroupInfo(groupId) {
  try {
    const result = await pool.query(
      "SELECT * FROM groups WHERE group_id = $1",
      [groupId]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("Error getting group info:", error);
    throw error;
  }
}

// Helper function to save group info
async function saveGroupInfo(
  groupId,
  adminId,
  accountName,
  accountNumber,
  bankName,
  price
) {
  try {
    const result = await pool.query(
      `INSERT INTO groups (group_id, admin_id, account_name, account_number, bank_name, price) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       ON CONFLICT (group_id) 
       DO UPDATE SET 
         admin_id = $2,
         account_name = $3,
         account_number = $4,
         bank_name = $5,
         price = $6
       RETURNING id`,
      [groupId, adminId, accountName, accountNumber, bankName, price]
    );
    return result.rows[0].id;
  } catch (error) {
    console.error("Error saving group info:", error);
    throw error;
  }
}

// Helper function to save payment
async function savePayment(
  userId,
  username,
  firstName,
  groupId,
  screenshotFileId
) {
  try {
    const result = await pool.query(
      "INSERT INTO payments (user_id, username, first_name, group_id, screenshot_file_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [userId, username, firstName, groupId, screenshotFileId]
    );
    return result.rows[0].id;
  } catch (error) {
    console.error("Error saving payment:", error);
    throw error;
  }
}

// Helper function to update payment status
async function updatePaymentStatus(paymentId, status, addedDate = null) {
  try {
    let query, params;

    if (addedDate) {
      query =
        "UPDATE payments SET status = $1, added_date = $2 WHERE id = $3 RETURNING *";
      params = [status, addedDate, paymentId];
    } else {
      query = "UPDATE payments SET status = $1 WHERE id = $2 RETURNING *";
      params = [status, paymentId];
    }

    const result = await pool.query(query, params);
    return result.rowCount;
  } catch (error) {
    console.error("Error updating payment status:", error);
    throw error;
  }
}

// Store user sessions for multi-step processes
const userSessions = {};

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (msg.chat.type === "private") {
    // Private chat - show options to user
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Pay for Group Access",
              callback_data: "pay_for_access",
            },
          ],
          [{ text: "ℹ️ Help", callback_data: "help" }],
        ],
      },
    };

    bot.sendMessage(
      chatId,
      `Welcome to Group Subscription Bot!\n\n` + `Choose an option below:`,
      keyboard
    );
  } else {
    // Group chat - check if user is admin and send private message
    try {
      const isAdmin = await isGroupAdmin(chatId, userId);
      if (isAdmin) {
        // Send admin panel to the admin's private chat
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Setup Payment Details",
                  callback_data: `setup_payment_${chatId}`,
                },
              ],
              [
                {
                  text: "View Pending Payments",
                  callback_data: `view_pending_${chatId}`,
                },
              ],
            ],
          },
        };

        // Send private message to admin
        try {
          await bot.sendMessage(
            userId,
            `Admin Panel for Group ${chatId}\n\n` +
              `Click below to setup payment details or view pending payments:`,
            keyboard
          );

          // Optionally send a brief confirmation in the group that only the admin can see
          bot.sendMessage(
            chatId,
            `@${
              msg.from.username || msg.from.first_name
            }, I've sent you the admin panel in our private chat.`
          );
        } catch (error) {
          if (
            error.response &&
            error.response.body &&
            error.response.body.error_code === 403
          ) {
            bot.sendMessage(
              chatId,
              `@${
                msg.from.username || msg.from.first_name
              }, please start a private chat with me first by clicking here: @${
                (await bot.getMe()).username
              }, then use /start again in this group.`
            );
          } else {
            throw error;
          }
        }
      } else {
        // Regular member - send them to private chat
        bot.sendMessage(
          chatId,
          `@${
            msg.from.username || msg.from.first_name
          }, please message me privately to pay for group access: @${
            (await bot.getMe()).username
          }`
        );
      }
    } catch (error) {
      console.error("Error checking admin status:", error);
    }
  }
});

// Handle callback queries
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    if (data === "pay_for_access") {
      // Show list of available groups
      const result = await pool.query(
        "SELECT * FROM groups WHERE account_name IS NOT NULL"
      );
      const groups = result.rows;

      if (groups.length === 0) {
        bot.answerCallbackQuery(query.id, { text: "No groups available" });
        bot.editMessageText("❌ No groups are currently accepting payments.", {
          chat_id: chatId,
          message_id: query.message.message_id,
        });
        return;
      }

      const keyboard = {
        reply_markup: {
          inline_keyboard: groups.map((group) => [
            {
              text: `Group ${group.group_id} - ₦${group.price}`,
              callback_data: `select_group_${group.group_id}`,
            },
          ]),
        },
      };

      bot.editMessageText("Select a group to pay for:", {
        chat_id: chatId,
        message_id: query.message.message_id,
        ...keyboard,
      });
    } else if (data.startsWith("select_group_")) {
      const groupId = data.replace("select_group_", "");
      const groupInfo = await getGroupInfo(groupId);

      if (groupInfo) {
        const keyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Payment Made",
                  callback_data: `payment_made_${groupId}`,
                },
              ],
              [{ text: "Back", callback_data: "pay_for_access" }],
            ],
          },
        };

        bot.editMessageText(
          `Payment Details\n\n` +
            `Amount: ₦${groupInfo.price}\n` +
            `Bank Name: ${groupInfo.bank_name}\n` +
            `Account Name: ${groupInfo.account_name}\n` +
            `Account Number: ${groupInfo.account_number}\n\n` +
            `Please make the payment and click "Payment Made" below, then send your payment receipt.`,
          { chat_id: chatId, message_id: query.message.message_id, ...keyboard }
        );
      }
    } else if (data.startsWith("payment_made_")) {
      const groupId = data.replace("payment_made_", "");
      userSessions[userId] = { step: "waiting_screenshot", groupId };

      bot.editMessageText(
        `Great! Now please send your payment receipt screenshot.`,
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } else if (data.startsWith("setup_payment_")) {
      const groupId = data.replace("setup_payment_", "");

      // Check if user is admin of the group
      const isAdmin = await isGroupAdmin(groupId, userId);
      if (!isAdmin) {
        bot.answerCallbackQuery(query.id, {
          text: "Only admins can setup payments",
        });
        return;
      }

      // Start the setup process in private chat
      userSessions[userId] = { step: "account_name", groupId };

      bot.editMessageText(
        `Setting up payment details for Group ${groupId}\n\n` +
          `Please enter the account name for payments:`,
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } else if (data.startsWith("view_pending_")) {
      const groupId = data.replace("view_pending_", "");
      const isAdmin = await isGroupAdmin(groupId, userId);

      if (isAdmin) {
        const result = await pool.query(
          "SELECT * FROM payments WHERE group_id = $1 AND status = 'pending' ORDER BY payment_date DESC",
          [groupId]
        );
        const payments = result.rows;

        if (payments.length === 0) {
          bot.sendMessage(chatId, "No pending payments found.");
          return;
        }

        payments.forEach((payment) => {
          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "User Added to Group",
                    callback_data: `user_added_${payment.id}`,
                  },
                ],
                [
                  {
                    text: "Reject Payment",
                    callback_data: `reject_payment_${payment.id}`,
                  },
                ],
              ],
            },
          };

          bot.sendPhoto(chatId, payment.screenshot_file_id, {
            caption:
              `Payment Receipt\n\n` +
              `User: ${payment.first_name} (@${payment.username || "N/A"})\n` +
              `User ID: ${payment.user_id}\n` +
              `Date: ${new Date(payment.payment_date).toLocaleString()}\n\n` +
              `Please add this user to the group manually, then click "User Added" below.`,
            ...keyboard,
          });
        });
      }
    } else if (data.startsWith("user_added_")) {
      const paymentId = data.replace("user_added_", "");
      const addedDate = new Date().toISOString();
      await updatePaymentStatus(paymentId, "approved", addedDate);

      // Schedule user removal after 30 days
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
      const removalDate = new Date(Date.now() + thirtyDaysMs);

      // Store removal task in database for persistence
      await pool.query("UPDATE payments SET removal_date = $1 WHERE id = $2", [
        removalDate.toISOString(),
        paymentId,
      ]);

      console.log(`User will be removed on: ${removalDate.toLocaleString()}`);

      bot.editMessageCaption(
        query.message.caption +
          `\n\n✅ USER ADDED TO GROUP - Will be removed in 30 days`,
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } else if (data.startsWith("reject_payment_")) {
      const paymentId = data.replace("reject_payment_", "");
      await updatePaymentStatus(paymentId, "rejected");

      bot.editMessageCaption(
        query.message.caption + `\n\n❌ PAYMENT REJECTED`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
        }
      );
    }

    bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.error("Callback query error:", error);
    bot.answerCallbackQuery(query.id, { text: "An error occurred" });
  }
});

// Handle text messages - this now only works in private chats for user sessions
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return; // Skip commands
  if (msg.chat.type !== "private") return; // Only handle text input in private chats

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = userSessions[userId];

  if (session) {
    try {
      if (session.step === "account_name") {
        session.accountName = msg.text;
        session.step = "bank_name";
        bot.sendMessage(chatId, "🏦 Please enter the bank name:");
      } else if (session.step === "bank_name") {
        session.bankName = msg.text;
        session.step = "account_number";
        bot.sendMessage(chatId, "🔢 Please enter the account number:");
      } else if (session.step === "account_number") {
        session.accountNumber = msg.text;
        session.step = "price";
        bot.sendMessage(
          chatId,
          "💰 Please enter the subscription price (numbers only, e.g., 1000):"
        );
      } else if (session.step === "price") {
        const price = msg.text;

        await saveGroupInfo(
          session.groupId,
          userId,
          session.accountName,
          session.accountNumber,
          session.bankName,
          price
        );
        bot.sendMessage(
          chatId,
          `✅ Payment details saved successfully!\n\n` +
            `Bank Name: ${session.bankName}\n` +
            `Account Name: ${session.accountName}\n` +
            `Account Number: ${session.accountNumber}\n` +
            `Price: ₦${price}\n\n` +
            `Your group is now ready to accept payments!`
        );
        delete userSessions[userId];
      }
    } catch (error) {
      bot.sendMessage(
        chatId,
        "❌ Error saving payment details. Please try again."
      );
      console.error(error);
    }
  }
});

// Handle photos (payment screenshots) - only in private chats
bot.on("photo", async (msg) => {
  if (msg.chat.type !== "private") return; // Only handle photos in private chats

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const session = userSessions[userId];

  if (session && session.step === "waiting_screenshot") {
    const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
    const username = msg.from.username;
    const firstName = msg.from.first_name;

    try {
      await savePayment(
        userId,
        username,
        firstName,
        session.groupId,
        photo.file_id
      );

      // Notify the group admin privately
      const groupInfo = await getGroupInfo(session.groupId);
      if (groupInfo && groupInfo.admin_id) {
        try {
          await bot.sendMessage(
            groupInfo.admin_id,
            `🔔 New payment notification for Group ${session.groupId}!\n\n` +
              `User: ${firstName} (@${username || "N/A"})\n` +
              `User ID: ${userId}\n` +
              `Payment Date: ${new Date().toLocaleString()}\n\n` +
              `Use the "View Pending Payments" option to review the receipt.`
          );
        } catch (error) {
          console.error("Could not notify admin:", error);
        }
      }

      bot.sendMessage(
        chatId,
        `✅ Payment receipt received!\n\n` +
          `Your payment is now under review. The group admin will add you to the group once verified.\n\n` +
          `Please wait for confirmation.`
      );

      delete userSessions[userId];
    } catch (error) {
      bot.sendMessage(
        chatId,
        "❌ Error processing your payment. Please try again."
      );
      console.error(error);
    }
  }
});

// Function to check for expired subscriptions and remove users
async function checkExpiredSubscriptions() {
  try {
    const now = new Date().toISOString();

    const result = await pool.query(
      "SELECT * FROM payments WHERE status = 'approved' AND removal_date <= $1 AND removal_date IS NOT NULL",
      [now]
    );
    const expiredPayments = result.rows;

    for (const payment of expiredPayments) {
      try {
        // Use banChatMember then unbanChatMember to remove user (modern method)
        await bot.banChatMember(payment.group_id, payment.user_id);
        await bot.unbanChatMember(payment.group_id, payment.user_id);

        // Update payment status to expired
        await updatePaymentStatus(payment.id, "expired");

        console.log(
          `User ${payment.user_id} (${payment.first_name}) removed from group ${payment.group_id} - subscription expired`
        );

        // Optionally notify the user
        try {
          await bot.sendMessage(
            payment.user_id,
            `⏰ Your subscription to group ${payment.group_id} has expired. You have been removed from the group.\n\n` +
              `To rejoin, please make a new payment.`
          );
        } catch (notifyError) {
          console.log(
            "Could not notify user of expiration:",
            notifyError.message
          );
        }
      } catch (error) {
        console.error(`Error removing expired user ${payment.user_id}:`, error);
      }
    }
  } catch (error) {
    console.error("Error checking expired subscriptions:", error);
  }
}

// Check for expired subscriptions every hour
setInterval(checkExpiredSubscriptions, 60 * 60 * 1000);

// Check immediately on startup
checkExpiredSubscriptions();

// Webhook endpoint for production
if (useWebhook) {
  import("express").then(({ default: express }) => {
    const app = express();
    app.use(express.json());

    // Health check endpoint
    app.get("/", (req, res) => {
      res.json({
        status: "Bot is running",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
      });
    });

    // Webhook endpoint
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
      bot.processUpdate(req.body);
      res.sendStatus(200);
    });

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Webhook server is running on port ${PORT}`);
      console.log(`🤖 Bot is ready to receive updates`);
    });

    // Graceful shutdown
    process.on("SIGTERM", () => {
      console.log("SIGTERM received. Shutting down gracefully...");
      server.close(() => {
        console.log("Server closed");
        pool.end();
        process.exit(0);
      });
    });
  });
} else {
  // Handle errors for polling mode
  bot.on("polling_error", (error) => {
    console.error("Polling error:", error);
  });
}

// Graceful shutdown for development mode
process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down gracefully...");
  pool.end();
  process.exit(0);
});

console.log("🤖 Bot initialization complete...");
