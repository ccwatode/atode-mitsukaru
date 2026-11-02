"""
予定機能のブラウザ検証（iPhone相当の画面・タッチ）。架空の文章と生成したPDFだけを使う。
使い方: python3 test/e2e_calendar.py <dist> <チラシPDF> <出力先>
"""
import functools, http.server, json, os, sys, threading, zipfile
from playwright.sync_api import sync_playwright, expect

DIST, FLYER, OUT = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8782), functools.partial(Q, directory=DIST))
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:8782/'

NOTICE1 = """【運動会のお知らせ】
保護者各位　2026年9月1日
下記のとおり運動会を行います。
日時：10月10日（土）9:00〜12:00
場所：〇〇小学校 校庭
雨天の場合は10月11日（日）に延期します。
参加申込書は9月18日（金）までに提出してください。
9月30日（水）は準備のため午後から休園となります。
10月9日（金）は体操服を持参してください。"""
NOTICE2 = "【運動会の日程変更】2026年10月1日\n運動会は10月17日（土）9:00〜12:00に変更します。"
NOTICE3 = "【運動会について】2026年10月15日\n10月17日（土）の運動会は中止します。"

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS' if ok else 'FAIL'), name, detail)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
                        accept_downloads=True, timezone_id='Asia/Tokyo', locale='ja-JP')
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=URL[:-1])
    ctx.add_init_script("delete ReadableStream.prototype[Symbol.asyncIterator]; delete ReadableStream.prototype.values; localStorage.setItem('icsMode','download');")
    page = ctx.new_page()
    errors, requests = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    page.on('request', lambda r: requests.append(r.url))
    nav = page.get_by_role('navigation', name='画面の切り替え')
    dlg = lambda name: page.get_by_role('dialog', name=name)
    shot = lambda n: page.screenshot(path=f'{OUT}/{n}.png')

    def goto_month(y, m):
        for _ in range(24):
            h = page.locator('.cal-title').inner_text().replace('\n', '')
            cy, cm = int(h.split('年')[0]), int(h.split('年')[1].rstrip('月'))
            if (cy, cm) == (y, m): return
            page.get_by_role('button', name='前の月' if (cy, cm) > (y, m) else '次の月').click()

    def add_notice(text):
        page.evaluate("t => navigator.clipboard.writeText(t)", text)
        nav.get_by_role('button', name='追加').click()
        dlg('何を追加しますか？').get_by_role('button', name='お知らせの文章').click()
        expect(page.get_by_role('heading', name='お知らせを追加')).to_be_visible()
        page.get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('.src-events')).to_be_visible()

    page.goto(URL)
    expect(nav).to_be_visible()

    # --- 1. お知らせから予定候補 ---
    add_notice(NOTICE1)
    btn = page.locator('.src-events button.btn')
    check('お知らせ保存後に候補数を表示', '予定の候補 5件' in btn.inner_text(), btn.inner_text())
    shot('c01_notice_detail')
    btn.click()
    expect(page.get_by_role('heading', name='予定の候補')).to_be_visible()
    cards = page.locator('section.cand')
    texts = [cards.nth(i).inner_text() for i in range(cards.count())]
    check('候補5件（行事・予備日・締切・休園・持ち物）', cards.count() == 5 and all(any(k in t for t in texts) for k in ['行事', '予備日', '提出・締切', '休園', '持ち物・準備']), str(cards.count()))
    first = cards.nth(0)
    check('行事の候補：名前・日付・時刻・場所', first.get_by_label('名前').input_value() == '運動会' and first.get_by_label('日付').input_value() == '2026-10-10'
          and first.get_by_label('開始').input_value() == '09:00' and first.get_by_label('終了').input_value() == '12:00' and '校庭' in first.get_by_label('場所').input_value())
    check('年を推定した旨を表示', '年は書かれていないため2026年としました' in texts[0])
    shot('c02_review')
    page.get_by_role('button', name='5件を反映').click()
    expect(page.get_by_text('予定を5件反映しました')).to_be_visible()
    check('元のお知らせに予定5件が紐づく', page.locator('.src-events .ev-row').count() == 5)
    shot('c03_linked')

    # --- 2. 同じお知らせからもう一度：重複しない ---
    page.locator('.src-events button.btn').click()
    cards = page.locator('section.cand')
    check('再取り出し：全件「登録済み」で重複しない', cards.count() == 5 and all('登録済み' in cards.nth(i).inner_text() for i in range(5))
          and page.get_by_role('button', name='選択なし').is_disabled())
    page.get_by_role('button', name='やめる').click()

    # 同じ文章を別のお知らせとして再取り込み
    add_notice(NOTICE1)
    check('同じ文章の再取り込みで候補0件', 'の候補' not in page.locator('.src-events button.btn').inner_text())

    # --- 3. 変更のお知らせ：差分を確認して更新 ---
    add_notice(NOTICE2)
    page.locator('.src-events button.btn').click()
    c = page.locator('section.cand').first
    ctext = c.inner_text()
    check('変更を検知して差分を表示', '登録済みの予定と違いがあります' in ctext and '10月10日（土） → 10月17日（土）' in ctext, ctext.replace('\n', ' | ')[:200])
    shot('c04_review_changed')
    page.get_by_role('button', name='1件を反映').click()
    expect(page.get_by_text('予定を1件反映しました')).to_be_visible()

    # --- 4. カレンダー ---
    nav.get_by_role('button', name='予定').click()
    goto_month(2026, 10)
    page.get_by_role('gridcell', name='10月17日（土） 予定1件').click()
    rows = page.locator('section.month').first.locator('.ev-row')
    check('カレンダー：変更後の日に運動会', rows.count() == 1 and '運動会' in rows.first.inner_text() and '09:00〜12:00' in rows.first.inner_text())
    check('カレンダー：元の日（10/10）には予定なし', page.get_by_role('gridcell', name='10月10日（土） 予定0件').count() == 1)
    shot('c05_calendar')
    rows.first.click()
    d = page.locator('main').inner_text()
    check('予定の詳細：変更の記録・元のお知らせ', '変更の記録' in d and '10月10日（土） → 10月17日（土）' in d and '【運動会のお知らせ】' in d and '【運動会の日程変更】' in d)
    shot('c06_event_detail')

    # .ics
    with page.expect_download() as dl:
        page.get_by_role('button', name='iPhoneのカレンダーに追加').click()
    ics_path = os.path.join(OUT, 'one.ics'); dl.value.save_as(ics_path)
    ics = open(ics_path, encoding='utf-8', newline='').read()
    unfold = ics.replace('\r\n ', '')
    check('.ics の内容（時刻・タイムゾーン・UID・元のお知らせ）', ics.startswith('BEGIN:VCALENDAR\r\n') and 'DTSTART;TZID=Asia/Tokyo:20261017T090000' in ics
          and 'DTEND;TZID=Asia/Tokyo:20261017T120000' in ics and '@atode-mitsukaru' in ics and 'SEQUENCE:1' in ics and '元のお知らせ：【運動会のお知らせ】' in unfold, dl.value.suggested_filename)
    href = page.get_by_role('link', name='Googleカレンダーで開く').get_attribute('href')
    check('Googleカレンダーのリンク', href.startswith('https://calendar.google.com/calendar/render?action=TEMPLATE') and 'dates=20261017T090000%2F20261017T120000' in href and 'ctz=Asia%2FTokyo' in href)
    expect(page.get_by_text('最後に追加')).to_be_visible()
    check('書き出し日時を記録', True)

    # 元のお知らせへ
    page.locator('.src-link').click()
    expect(page.get_by_role('heading', name='【運動会のお知らせ】')).to_be_visible()
    check('予定から元のお知らせを開ける', True)

    # --- 5. 中止のお知らせ ---
    add_notice(NOTICE3)
    page.locator('.src-events button.btn').click()
    ctext = page.locator('section.cand').first.inner_text()
    check('中止を検知', '登録済みの予定の中止' in ctext, ctext[:120])
    page.get_by_role('button', name='1件を反映').click()
    nav.get_by_role('button', name='予定').click()
    goto_month(2026, 10)
    page.get_by_role('gridcell', name='10月17日（土） 予定1件').click()
    r = page.locator('section.month').first.locator('.ev-row').first
    check('カレンダーで中止を表示', '中止' in r.inner_text())
    r.click()
    check('中止後は「書き出し後に変更あり」を表示', 'カレンダーに入れた後に内容が変わっています' in page.locator('main').inner_text())

    # --- 6. 手で予定を追加（未来の日） ---
    nav.get_by_role('button', name='予定').click()
    goto_month(2026, 12)
    page.get_by_role('gridcell', name='12月4日（金） 予定0件').click()
    page.get_by_role('button', name='この日に予定を追加').click()
    page.get_by_label('予定の名前').fill('個人面談')
    page.get_by_label('終日').uncheck()
    page.get_by_label('開始').fill('15:00')
    page.get_by_label('種類').select_option('event')
    page.get_by_role('button', name='登録').click()
    expect(page.get_by_text('予定を登録しました')).to_be_visible()
    d = page.locator('main').inner_text()
    check('手で追加：日付・時刻・手入力の表示', '12月4日（金）' in d and '15:00' in d and '手で追加した予定です' in d)
    nav.get_by_role('button', name='ホーム').click()
    up = page.locator('.upcoming')
    check('ホームに近いうちの予定', up.count() == 1 and '個人面談' in up.inner_text())
    shot('c07_home_upcoming')

    # まとめて書き出し
    nav.get_by_role('button', name='予定').click()
    with page.expect_download() as dl:
        page.get_by_role('button', name='まだカレンダーに入れていない予定').click()
    many = open(dl.value.path(), encoding='utf-8').read()
    check('まとめて .ics（今後の未書き出し分）', many.count('BEGIN:VEVENT') == 1 and '個人面談' in many)
    shot('c08_calendar_dec')

    # --- 7. チラシPDFの文字から候補 ---
    nav.get_by_role('button', name='追加').click()
    with page.expect_file_chooser() as fc:
        dlg('何を追加しますか？').get_by_role('button', name='チラシ・配布資料').click()
    fc.value.set_files(FLYER)
    expect(page.get_by_role('heading', name='チラシ・資料を追加')).to_be_visible()
    page.get_by_role('button', name='保存', exact=True).click()
    expect(page.locator('.src-events')).to_be_visible()
    page.locator('.src-events button.btn').click()
    c = page.locator('section.cand').first
    check('チラシPDFの文字から候補（日付・時刻）', c.get_by_label('日付').input_value() == '2026-10-24' and c.get_by_label('開始').input_value() == '09:30' and c.get_by_label('終了').input_value() == '11:00')
    page.get_by_role('button', name='やめる').click()

    # --- 8. バックアップ → 全削除 → 復元 ---
    nav.get_by_role('button', name='データ').click()
    page.get_by_role('button', name='バックアップを作成').click()
    bd = dlg('バックアップを作成しました'); expect(bd).to_be_visible(timeout=30000)
    with page.expect_download() as dl:
        bd.get_by_role('button', name='ファイルに保存').click()
    zpath = os.path.join(OUT, 'backup.zip'); dl.value.save_as(zpath)
    zf = zipfile.ZipFile(zpath)
    evs = json.loads(zf.read('events.json'))
    man = json.loads(zf.read('manifest.json'))
    check('バックアップに予定を含む', len(evs) == 6 and man['version'] == 3 and man['counts']['events'] == 6, str(len(evs)))
    page.get_by_role('button', name='この端末のデータをすべて削除').click()
    dlg('すべて削除しますか？').get_by_role('button', name='削除する').click()
    expect(page.get_by_text('この端末のデータを削除しました')).to_be_visible()
    nav.get_by_role('button', name='データ').click()
    for n in (1, 2):
        with page.expect_file_chooser() as fc:
            page.get_by_role('button', name='バックアップから復元').click()
        fc.value.set_files(zpath)
        rr = dlg('復元が終わりました'); expect(rr).to_be_visible(timeout=30000)
        t = rr.inner_text()
        if n == 1: check('復元：予定6件', '予定：追加 6件' in t, t.replace('\n', ' | '))
        else: check('再復元：予定は重複しない', '予定：追加 0件／同じ 6件' in t, t.replace('\n', ' | '))
        rr.get_by_role('button', name='ホームで確認').click()
        nav.get_by_role('button', name='データ').click()
    nav.get_by_role('button', name='予定').click()
    goto_month(2026, 10)
    check('復元後の予定から元のお知らせへ', page.get_by_role('gridcell', name='10月17日（土） 予定1件').count() == 1)

    # ダーク表示
    page.emulate_media(color_scheme='dark'); shot('c09_dark_calendar'); page.emulate_media(color_scheme='light')

    ext = [u for u in requests if not u.startswith(URL) and not u.startswith('blob:') and not u.startswith('data:')]
    check('外部への通信なし', not ext, str(ext[:3]))
    check('エラーなし', not errors, str(errors[:3]))
    b.close()

ok = sum(1 for r in results if r[1])
print(f'\n{ok}/{len(results)} PASS')
sys.exit(0 if ok == len(results) else 1)
