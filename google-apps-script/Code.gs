const OWNER_EMAIL = 'legal.tsag@gmail.com';
const BOOKINGS_KEY = 'LAW_FIRM_BOOKINGS_V1';
const ALLOWED_ORIGIN = 'https://hangai1239-del.github.io';

function doGet(e) {
  const action = String((e.parameter && e.parameter.action) || 'health');
  if (action === 'availability') {
    const date = String(e.parameter.date || '');
    if (!validDate_(date)) return json_({ error: 'Огноо буруу байна.' });
    const bookedTimes = readBookings_()
      .filter(function (booking) { return booking.date === date; })
      .map(function (booking) { return booking.time; });
    return json_({ bookedTimes: bookedTimes });
  }
  return json_({ status: 'ok', service: 'law-firm-booking' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const data = JSON.parse((e.postData && e.postData.contents) || '{}');
    validateBooking_(data);
    lock.waitLock(10000);
    const bookings = readBookings_();
    if (bookings.some(function (booking) { return booking.date === data.date && booking.time === data.time; })) {
      return json_({ error: 'Энэ цаг захиалагдсан байна. Өөр цаг сонгоно уу.', code: 'SLOT_TAKEN' });
    }
    const booking = {
      id: Utilities.getUuid(),
      clientName: String(data.clientName).trim(),
      email: String(data.email).trim().toLowerCase(),
      phone: String(data.phone).trim(),
      message: String(data.message || '').trim(),
      date: data.date,
      time: data.time,
      createdAt: new Date().toISOString()
    };
    bookings.push(booking);
    PropertiesService.getScriptProperties().setProperty(BOOKINGS_KEY, JSON.stringify(bookings));
    sendEmails_(booking);
    return json_({ bookingId: booking.id, status: 'confirmed' });
  } catch (error) {
    return json_({ error: error.message || 'Серверийн алдаа гарлаа.' });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function validateBooking_(data) {
  const name = String(data.clientName || '').trim();
  const email = String(data.email || '').trim();
  const phone = String(data.phone || '').trim();
  const message = String(data.message || '');
  const time = String(data.time || '');
  if (!name || name.length > 254 || !phone || phone.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || message.length > 2000) {
    throw new Error('Нэр, имэйл, утасны мэдээллээ зөв бөглөнө үү.');
  }
  if (!validDate_(data.date) || !/^(?:(?:09|1[0-6]):(?:00|30)|17:00)$/.test(time)) {
    throw new Error('Ирээдүйн өдөр, боломжтой цаг сонгоно уу.');
  }
  const appointment = new Date(data.date + 'T' + time + ':00+08:00');
  if (appointment.getTime() <= Date.now()) throw new Error('Ирээдүйн өдөр, боломжтой цаг сонгоно уу.');
}

function validDate_(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !isNaN(new Date(date + 'T00:00:00Z').getTime());
}

function readBookings_() {
  const raw = PropertiesService.getScriptProperties().getProperty(BOOKINGS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (error) { return []; }
}

function sendEmails_(booking) {
  const details = 'Нэр: ' + booking.clientName + '\n' +
    'Имэйл: ' + booking.email + '\n' +
    'Утас: ' + booking.phone + '\n' +
    'Огноо: ' + booking.date + '\n' +
    'Цаг: ' + booking.time + ' (Улаанбаатарын цагаар)\n' +
    'Нэмэлт мэдээлэл: ' + (booking.message || '-');

  MailApp.sendEmail({
    to: OWNER_EMAIL,
    replyTo: booking.email,
    name: 'Сентрал Консалтинг',
    subject: 'Шинэ цаг захиалга — ' + booking.date + ' ' + booking.time,
    body: 'Шинэ цаг захиалагдлаа.\n\n' + details + '\n\nЗахиалгын дугаар: ' + booking.id
  });

  MailApp.sendEmail({
    to: booking.email,
    replyTo: OWNER_EMAIL,
    name: 'Сентрал Консалтинг',
    subject: 'Таны цаг баталгаажлаа — ' + booking.date + ' ' + booking.time,
    body: 'Сайн байна уу, ' + booking.clientName + '!\n\n' +
      'Таны цаг амжилттай захиалагдлаа.\n\n' + details + '\n\n' +
      'Цаг захиалгын хураамж 100,000 төгрөг болохыг анхаарна уу.\n\n' +
      'Баярлалаа.\nӨмгөөллийн Сентрал Консалтинг\n\nЗахиалгын дугаар: ' + booking.id
  });
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
