import TelegramBot from "node-telegram-bot-api";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";

dotenv.config();

// Replace with your bot token from BotFather
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN environment variable is required!");
  process.exit(1);
}
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Initialize sqlite3 with verbose mode
const db = new (sqlite3.verbose().Database)("bot.db");

console.log("Bot token loaded:", BOT_TOKEN ? "✓" : "✗");
console.log("Bot initialized:", bot ? "✓" : "✗");
console.log("Database initialized:", db ? "✓" : "✗");

// Initialize database tables
db.serialize(() => {
  // Groups table to store admin and payment info
  db.run(`CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY,
        group_id TEXT UNIQUE,
        admin_id TEXT,
        account_name TEXT,
        account_number TEXT,
        price TEXT
    )`);

  // Payments table to track user payments
  db.run(`CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        username TEXT,
        first_name TEXT,
        group_id TEXT,
        payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        screenshot_file_id TEXT,
        status TEXT DEFAULT 'pending',
        added_date DATETIME,
        removal_date DATETIME
    )`);
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
function getGroupInfo(groupId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM groups WHERE group_id = ?", [groupId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper function to save group info
function saveGroupInfo(groupId, adminId, accountName, accountNumber, price) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT OR REPLACE INTO groups (group_id, admin_id, account_name, account_number, price) VALUES (?, ?, ?, ?, ?)",
      [groupId, adminId, accountName, accountNumber, price],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// Helper function to save payment
function savePayment(userId, username, firstName, groupId, screenshotFileId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO payments (user_id, username, first_name, group_id, screenshot_file_id) VALUES (?, ?, ?, ?, ?)",
      [userId, username, firstName, groupId, screenshotFileId],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

// Helper function to update payment status
function updatePaymentStatus(paymentId, status, addedDate = null) {
  return new Promise((resolve, reject) => {
    const query = addedDate
      ? "UPDATE payments SET status = ?, added_date = ? WHERE id = ?"
      : "UPDATE payments SET status = ? WHERE id = ?";
    const params = addedDate
      ? [status, addedDate, paymentId]
      : [status, paymentId];

    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
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
      db.all(
        "SELECT * FROM groups WHERE account_name IS NOT NULL",
        [],
        (err, groups) => {
          if (err) {
            bot.answerCallbackQuery(query.id, { text: "Error loading groups" });
            return;
          }

          if (groups.length === 0) {
            bot.answerCallbackQuery(query.id, { text: "No groups available" });
            bot.editMessageText(
              "❌ No groups are currently accepting payments.",
              { chat_id: chatId, message_id: query.message.message_id }
            );
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
        }
      );
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
        db.all(
          "SELECT * FROM payments WHERE group_id = ? AND status = 'pending' ORDER BY payment_date DESC",
          [groupId],
          (err, payments) => {
            if (err || payments.length === 0) {
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
                  `User: ${payment.first_name} (@${
                    payment.username || "N/A"
                  })\n` +
                  `User ID: ${payment.user_id}\n` +
                  `Date: ${new Date(
                    payment.payment_date
                  ).toLocaleString()}\n\n` +
                  `Please add this user to the group manually, then click "User Added" below.`,
                ...keyboard,
              });
            });
          }
        );
      }
    } else if (data.startsWith("user_added_")) {
      const paymentId = data.replace("user_added_", "");
      await updatePaymentStatus(
        paymentId,
        "approved",
        new Date().toISOString()
      );

      // Schedule user removal after 30 days using a more reliable method
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
      const removalDate = new Date(Date.now() + thirtyDaysMs);

      // Store removal task in database for persistence
      db.run(
        "UPDATE payments SET removal_date = ? WHERE id = ?",
        [removalDate.toISOString(), paymentId],
        function (err) {
          if (err) {
            console.error("Error storing removal date:", err);
          }
        }
      );

      // For immediate testing, you can use a shorter timeout (e.g., 1 minute)
      // setTimeout(async () => {
      //   db.get(
      //     "SELECT * FROM payments WHERE id = ?",
      //     [paymentId],
      //     async (err, payment) => {
      //       if (payment && payment.status === "approved") {
      //         try {
      //           await bot.banChatMember(payment.group_id, payment.user_id);
      //           await bot.unbanChatMember(payment.group_id, payment.user_id);
      //           console.log(
      //             `User ${payment.user_id} removed from group ${payment.group_id} after expiry`
      //           );
      //         } catch (error) {
      //           console.error("Error removing user:", error);
      //         }
      //       }
      //     }
      //   );
      // }, 60000); // 1 minute for testing

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
    if (session.step === "account_name") {
      session.accountName = msg.text;
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

      try {
        await saveGroupInfo(
          session.groupId,
          userId,
          session.accountName,
          session.accountNumber,
          price
        );
        bot.sendMessage(
          chatId,
          `✅ Payment details saved successfully!\n\n` +
            `Account Name: ${session.accountName}\n` +
            `Account Number: ${session.accountNumber}\n` +
            `Price: ₦${price}\n\n` +
            `Your group is now ready to accept payments!`
        );
        delete userSessions[userId];
      } catch (error) {
        bot.sendMessage(
          chatId,
          "❌ Error saving payment details. Please try again."
        );
        console.error(error);
      }
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

// Handle errors
bot.on("polling_error", (error) => {
  console.error("Polling error:", error);
});

// Function to check for expired subscriptions and remove users
async function checkExpiredSubscriptions() {
  const now = new Date().toISOString();

  db.all(
    "SELECT * FROM payments WHERE status = 'approved' AND removal_date <= ? AND removal_date IS NOT NULL",
    [now],
    async (err, expiredPayments) => {
      if (err) {
        console.error("Error checking expired subscriptions:", err);
        return;
      }

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
          console.error(
            `Error removing expired user ${payment.user_id}:`,
            error
          );
        }
      }
    }
  );
}

// Check for expired subscriptions every hour
setInterval(checkExpiredSubscriptions, 60 * 60 * 1000);

// Check immediately on startup
checkExpiredSubscriptions();

console.log("🤖 Bot is running...");
