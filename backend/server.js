const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = Number(process.env.PORT || 4000);
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'legal.tsag@gmail.com';
// Allow the local VS Code preview to use the local booking API.
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (origin && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '16kb' }));
// Serve only public assets, never backend source or configuration.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));
app.get('/title_logo.png', (req, res) => res.sendFile(path.join(__dirname, '..', 'title_logo.png')));
app.use('/model', express.static(path.join(__dirname, '..', 'model')));

const bookingSchema = new mongoose.Schema({
  clientName: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, required: true, trim: true },
  message: { type: String, default: '', trim: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  status: { type: String, default: 'confirmed' },
  clientNotificationStatus: { type: String, enum: ['pending', 'sent'] },
  ownerNotificationStatus: { type: String, enum: ['pending', 'sent'], default: 'pending' },
}, { timestamps: true });
bookingSchema.index({ date: 1, time: 1 }, {
  unique: true,
  partialFilterExpression: { status: 'confirmed' },
  name: 'unique_confirmed_slot',
});
const Booking = mongoose.model('Booking', bookingSchema);

function mailConfigured() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}
let transport;
const notificationsInFlight = new Set();
function bookingDetails(booking) {
  return `Нэр: ${booking.clientName}\nИмэйл: ${booking.email}\nУтас: ${booking.phone}\nОгноо: ${booking.date}\nЦаг: ${booking.time} (Улаанбаатарын цагаар)\nНэмэлт мэдээлэл: ${booking.message || '-'}`;
}
function clientEmailText(booking) {
  const bankDetails = process.env.PAYMENT_BANK && process.env.PAYMENT_ACCOUNT && process.env.PAYMENT_ACCOUNT_NAME
    ? `Банк: ${process.env.PAYMENT_BANK}\nДанс: ${process.env.PAYMENT_ACCOUNT}\nДанс эзэмшигч: ${process.env.PAYMENT_ACCOUNT_NAME}`
    : 'Дансны мэдээллийг бидэнтэй холбогдож авна уу.';
  return `Сайн байна уу, ${booking.clientName}!\n\nӨмгөөллийн Сентрал Консалтингийг сонгосонд баярлалаа.\nТаны цаг амжилттай захиалагдлаа.\n\n${bookingDetails(booking)}\n\nЦаг захиалгын хураамж 100,000 төгрөг болохыг анхаарна уу.\n${bankDetails}\n\nБаярлалаа.\nӨмгөөллийн Сентрал Консалтинг\n\nЗахиалгын дугаар: ${booking._id}`;
}
const notifyOwner = booking => notifyBooking(booking, 'owner');
const notifyClient = booking => notifyBooking(booking, 'client');
async function notifyBooking(booking, recipient) {
  const id = String(booking._id);
  const field = recipient === 'client' ? 'clientNotificationStatus' : 'ownerNotificationStatus';
  const key = `${id}:${recipient}`;
  if (booking[field] === 'sent') return true;
  if (!mailConfigured() || notificationsInFlight.has(key)) return false;
  notificationsInFlight.add(key);
  try {
    transport ||= nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    await transport.sendMail({
      from: `Сентрал Консалтинг <${process.env.GMAIL_USER}>`,
      to: recipient === 'client' ? booking.email : OWNER_EMAIL,
      replyTo: recipient === 'client' ? OWNER_EMAIL : booking.email,
      subject: recipient === 'client' ? `Таны цаг баталгаажлаа — ${booking.date} ${booking.time}` : `Шинэ цаг захиалга — ${booking.date} ${booking.time}`,
      text: recipient === 'client' ? clientEmailText(booking) : `Шинэ цаг захиалагдлаа.\n\nНэр: ${booking.clientName}\nИмэйл: ${booking.email}\nУтас: ${booking.phone}\nОгноо: ${booking.date}\nЦаг: ${booking.time} (Улаанбаатарын цагаар)\nНэмэлт мэдээлэл: ${booking.message || '-'}\n\nЗахиалгын дугаар: ${id}`,
    });
    await Booking.updateOne({ _id: booking._id }, { $set: { [field]: 'sent' } });
    return true;
  } catch (error) {
    console.error(`${recipient} notification failed; will retry:`, error.code || error.name);
    return false;
  } finally {
    notificationsInFlight.delete(key);
  }
}
let retrying = false;
async function retryNotifications() {
  if (retrying || !mailConfigured() || mongoose.connection.readyState !== 1) return;
  retrying = true;
  try {
    const bookings = await Booking.find({ status: 'confirmed', $or: [{ ownerNotificationStatus: 'pending' }, { clientNotificationStatus: 'pending' }] }).sort({ createdAt: 1 }).limit(20);
    for (const booking of bookings) {
      if (booking.ownerNotificationStatus === 'pending') await notifyOwner(booking);
      if (booking.clientNotificationStatus === 'pending') await notifyClient(booking);
    }
  } catch (error) {
    console.error('Notification retry failed:', error.code || error.name);
  } finally { retrying = false; }
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
app.get('/api/health', (req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
  status: mongoose.connection.readyState === 1 ? 'ok' : 'database_unavailable',
  email: mailConfigured() ? 'configured' : 'not_configured',
}));
app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) return res.status(503).json({
    error: 'Захиалгын сантай холбогдохгүй байна. Интернэт болон MongoDB-ийн IP зөвшөөрлийг шалгаад дахин оролдоно уу.'
  });
  next();
});
app.get('/api/availability', async (req, res, next) => {
  try {
    if (!validDate(req.query.date)) return res.status(400).json({ error: 'Огноо буруу байна.' });
    const bookings = await Booking.find({ date: req.query.date, status: 'confirmed' }).select('time -_id');
    res.json({ bookedTimes: bookings.map(item => item.time) });
  } catch (error) { next(error); }
});
app.post('/api/bookings', async (req, res, next) => {
  try {
    const { clientName, email, phone, message = '', date, time } = req.body || {};
    if (![clientName, email, phone].every(value => typeof value === 'string' && value.trim() && value.length <= 254) ||
        typeof message !== 'string' || message.length > 2000 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Нэр, имэйл, утасны мэдээллээ зөв бөглөнө үү.' });
    }
    if (!validDate(date) || typeof time !== 'string' || !/^(?:(?:09|1[0-6]):(?:00|30)|17:00)$/.test(time) ||
        new Date(`${date}T${time}:00+08:00`) <= new Date()) {
      return res.status(400).json({ error: 'Ирээдүйн өдөр, боломжтой цаг сонгоно уу.' });
    }
    const booking = await Booking.create({ clientName, email, phone, message, date, time, status: 'confirmed', clientNotificationStatus: 'pending' });
    const [sent, clientSent] = await Promise.all([notifyOwner(booking), notifyClient(booking)]);
    res.status(201).json({ bookingId: booking.id, status: 'confirmed', ownerNotification: sent ? 'sent' : 'pending', clientNotification: clientSent ? 'sent' : 'pending' });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Энэ цаг захиалагдсан байна. Өөр цаг сонгоно уу.' });
    next(error);
  }
});
app.use((error, req, res, next) => {
  console.error('Request failed:', error.code || error.name);
  if (/Mongo.*(?:Network|Selection)|MongooseServerSelection/.test(error.name)) {
    return res.status(503).json({ error: 'Захиалгын сантай холбогдохгүй байна. Интернэт болон MongoDB-ийн IP зөвшөөрлийг шалгаад дахин оролдоно уу.' });
  }
  res.status(500).json({ error: 'Серверийн алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу.' });
});
async function start() {
  if (!process.env.MONGO_URI) throw new Error('Missing environment variable: MONGO_URI');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  await Booking.init();
  if (!mailConfigured()) console.warn('Gmail is not configured. Owner notifications are queued until GMAIL_USER and GMAIL_APP_PASSWORD are set and the server is restarted.');
  const server = app.listen(PORT, () => console.log(`Website running at http://localhost:${PORT}`));
  retryNotifications();
  const timer = setInterval(retryNotifications, 60000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}
if (require.main === module) start().catch(error => {
  console.error('Startup failed:', error.code || error.name);
  process.exit(1);
});
module.exports = { app, Booking, notifyOwner, notifyClient, clientEmailText, retryNotifications, start };
