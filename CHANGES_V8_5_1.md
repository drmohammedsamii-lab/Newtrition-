# Newtrition — النسخة النهائية المُتحقق منها (v8.5.1)

هذه نسخة كاملة، مُختبرة فعليًا من الصفر (Postgres 16 حقيقي + سيرفر حقيقي)،
مطابقة تمامًا لما هو منشور الآن على Railway.

## هيكل المشروع

```
/                        ← كود الـ API (server.js وكل الـ engines)
/database                ← كل ملفات SQL (schema + 20 migration بالترتيب)
/migrate.js               ← أداة تحميل القاعدة (بديل psql — Railway مفيهاش psql)
```

## طريقة التشغيل من الصفر (محليًا)

```bash
npm install
createdb newtrition
DATABASE_URL=postgres://user:pass@localhost/newtrition node migrate.js
DATABASE_URL=postgres://user:pass@localhost/newtrition node create-owner.js "email" "الاسم" "كلمة-سر"
DATABASE_URL=postgres://user:pass@localhost/newtrition node populate-allergens.js
DATABASE_URL=postgres://user:pass@localhost/newtrition npm start
```

`migrate.js` آمن يتعاد تشغيله (idempotent) — بيسجل كل ملف اتطبق في جدول
`schema_migrations` ومش بيكرر تحميل الأكل لو الجدول فيه بيانات بالفعل.

## الإصلاحات اللي اتعملت في الجلسة دي (كلها اتجربت فعليًا)

1. **`database/migrate_v4_1_constraints.sql`** — كان بيعرّف
   `v_food_candidate_intelligence` مرتين بترتيب أعمدة مختلف، فـ Postgres
   كان بيرفض. الحل: `DROP VIEW IF EXISTS ... CASCADE` قبل التعريف الثاني.

2. **`database/schema_allergen_safety.sql`** — نفس المشكلة بالظبط لنفس الـ view.

3. **مجلد `api/` في الـ repo** — كان فيه ~400 ملف غلط (بواقي `node_modules`
   مفكوكة زي `LICENSE (10)`, `index (24).js`...) و`package.json` بتاع
   مكتبة تانية اسمها `pgpass`. اتمسح بالكامل — مش مستخدم في السيرفر أصلًا.

4. **الصفحة الرئيسية كانت بترجع 404** — `server.js` بيدوّر على `public/`
   لكن `index.html` و`client.html` في الجذر. الحل: أمر `start` بينسخهم
   لـ `public/` قبل تشغيل السيرفر (متضمن في start command على Railway).

5. **`populate-allergens.js` كان بيقع بالكامل** — بيكتب عمود `source_ref`
   في `food_allergen` لكن مفيش أي migration عملت العمود ده. النتيجة كانت
   1966/1966 صنف بدون أي تصنيف حساسية. الحل: migration جديد
   `migrate_v8_5_1_allergen_source_ref.sql` بيضيف العمود ويحل تعارض بين
   نسختين من `CHECK constraint`.

6. **ملفات مكررة بمسافة في الاسم** (`food data.sql` بدل `food_data.sql`)
   و`schema.sql`/`setup.sh` في الجذر (نسخ قديمة مش مستخدمة) — اتشالوا من
   النسخة دي لتفادي اللخبطة. المصدر الوحيد للحقيقة هو `database/`.

## النتيجة النهائية (مُتحقق منها بتشغيل حقيقي)

- **21 migration** تنجح بالترتيب من قاعدة فاضية تمامًا
- **1,966 صنف غذائي** محمّلين
- **612 صنف مُصنَّف حساسية** (847 علامة) — شامل حالة Chicken Alfredo (dairy
  مستنتج من الاسم مش مكتوب صراحة)، ومُتحقق إن "أرز أبيض" و"فول سوداني"
  مش بيتصنفوا غلط
- 13/13 اختبار end-to-end: تسجيل دخول، CSRF، صلاحيات، بحث عربي، إنشاء عميلة

## حالة النشر الحالية على Railway

الموقع شغال على `https://newtrition-production.up.railway.app` بنفس
الكود ده بالظبط. حساب المالك موجود بالفعل (راجع المحادثة لتفاصيل الدخول).
