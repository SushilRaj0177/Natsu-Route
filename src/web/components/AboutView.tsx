import { useEffect, useState } from 'react';
import { api, type AboutResponse } from '../api.ts';
import { useT } from '../i18n.ts';

const n = (x: number | undefined, lang: 'ja' | 'en') => (x === undefined ? '—' : x.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US'));
const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : '—');

/**
 * What the app does, how, with which data, how far to trust it, and who
 * made it. Written to ODPT's developer guideline: sources, the data's
 * dates, the dates of live data, a disclaimer and a contact.
 */
export function AboutView() {
  const { lang } = useT();
  const [a, setA] = useState<AboutResponse | null>(null);
  useEffect(() => {
    api.about().then(setA).catch(() => {});
  }, []);
  const ja = lang === 'ja';
  const k = a?.shade.byKind ?? {};
  return (
    <article className="about">
      <h2>{ja ? 'なつルートについて' : 'About NatsuRoute'}</h2>
      <p className="lead">
        {ja
          ? '暑い日に、日なたを歩く時間がいちばん短くなる道順を、家の玄関から行き先まで案内します。対象は東京23区。高齢の方や、その家族のためにつくりました。'
          : 'Door-to-door train and bus routes that keep you out of the sun on hot days, across Tokyo’s 23 wards. Made for older people and their families.'}
      </p>

      <h3>{ja ? 'なぜ' : 'Why'}</h3>
      <p>
        {ja
          ? '熱中症で救急搬送される人の半数以上は65歳以上で、道路など屋外での発生も少なくありません。乗換案内は「早さ」で道を選びますが、同じ時間でも、建物の影側の歩道や地下通路を通れば、日なたにいる時間を大きく減らせることがあります。'
          : 'More than half of the people taken to hospital with heatstroke in Japan are 65 or older, and many cases happen outdoors, on roads. Journey planners pick the fastest way; for the same time, the shady side of the street or an underground passage can cut time in the sun a lot.'}
      </p>

      <h3>{ja ? 'しくみ' : 'How it works'}</h3>
      <ol>
        <li>
          {ja
            ? '3D都市モデル（PLATEAU）の建物・樹木・高架橋の形と高さから、指定した時刻の太陽の位置で影を計算します（光線を一本ずつ太陽へ向けて飛ばし、建物にさえぎられるかを調べます）。'
            : 'Shade is worked out from the shapes and heights of buildings, trees and elevated decks in PLATEAU’s 3D city model, for the sun’s position at the minute you will be there: a ray is cast from each spot towards the sun and checked against everything in its way.'}
        </li>
        <li>
          {ja
            ? '歩道は道路の中心ではなく両側にあるので、道路ごとに左右の歩道の日陰をそれぞれ計算し、日陰側の歩道を案内します。アーケード・屋根付き通路・地下通路は日陰として扱います。'
            : 'Pavements run beside the road, not down its middle, so each side is shaded separately and you are told which side to walk on. Arcades, covered walkways and underground passages count as shade.'}
        </li>
        <li>
          {ja
            ? '暑さ指数（環境省）が高いほど、少し遠回りしても日陰の道を優先します。寒い季節は逆に日なたの道を、雨の日は屋根のある道を選べます。'
            : 'The higher the heat index (Ministry of the Environment), the more a detour into shade is worth. In winter it can pick sunny streets instead, and in rain, roofed ones.'}
        </li>
        <li>
          {ja
            ? '電車とバスは公共交通オープンデータセンター（ODPT）の時刻表から実際の便を探し、駅の出入口（段差の有無）、バス停で待つ時間の日なた・屋根の有無まで含めて比べます。'
            : 'Trains and buses come from the operators’ timetables via ODPT. Station entrances (step-free or not) and the wait at each bus stop, in sun or shade, roofed or not, are part of the comparison.'}
        </li>
      </ol>

      <h3>{ja ? '使っているデータ' : 'Data'}</h3>
      <dl className="data-list">
        <dt>{ja ? '建物・樹木・高架（影の計算）' : 'Buildings, trees, decks (shade)'}</dt>
        <dd>
          {ja ? '国土交通省 Project PLATEAU 3D都市モデル（東京23区, 2025年度）' : 'MLIT Project PLATEAU 3D city model (Tokyo 23 wards, 2025)'}: {ja ? '建物' : 'buildings'} {n(k.building, lang)}・{ja ? '樹木' : 'trees'} {n(k.tree, lang)}・{ja ? '高架・歩道橋' : 'decks'} {n(k.deck, lang)}
          <br />
          {ja ? '街路樹・樹林（補完）' : 'Street trees and woods (to fill gaps)'}: © OpenStreetMap contributors {n(k.osmTree, lang)}
        </dd>
        <dt>{ja ? '歩行者の道' : 'Walking network'}</dt>
        <dd>
          © OpenStreetMap contributors（ODbL）: {n(a?.walk.edges, lang)} {ja ? '区間' : 'segments'}
          <br />
          {ja ? '歩行空間ネットワークデータ（国土交通省 ほこナビDP、公共データ利用規約）' : 'MLIT walking-space network data (Hokonavi DP)'}: {n(a?.walk.hokonavi?.areas, lang)}
          {ja ? '地区・' : ' areas, '}
          {n(a?.walk.hokonavi?.links, lang)}
          {ja ? 'リンク。屋根・地下通路・建物内通路・階段・エレベーター・坂・段差を道に反映' : ' links: roofs, underground passages, corridors, stairs, lifts, slopes and kerbs'}
        </dd>
        <dt>{ja ? '電車・バスの時刻表と運賃' : 'Train and bus timetables, fares'}</dt>
        <dd>
          {ja ? '公共交通オープンデータセンター（ODPT）・公共交通オープンデータチャレンジ2026提供データ' : 'Public Transportation Open Data Center (ODPT), including ODPT Challenge 2026 data'}: {ja ? '駅' : 'stations'} {n(a?.transit.stations, lang)}・{ja ? 'バス停' : 'bus stops'} {n(a?.transit.busStops, lang)}・{ja ? '電車' : 'trains'}{' '}
          {n(a?.transit.railTrips, lang)}・{ja ? 'バス' : 'buses'} {n(a?.transit.busTrips, lang)}
          <br />
          {ja ? '時刻表の更新日' : 'Timetables issued'}: {day(a?.data.timetableIssued)} ／ {ja ? 'データ作成日' : 'built'}: {day(a?.data.builtAt)}
        </dd>
        <dt>{ja ? '暑さ指数・熱中症アラート' : 'Heat index and alerts'}</dt>
        <dd>{ja ? '環境省 熱中症予防情報サイト（予測値・実況推定値・熱中症警戒アラート）' : 'Ministry of the Environment heat illness prevention site (forecasts, estimates, alerts)'}</dd>
        <dt>{ja ? 'クーリングシェルター' : 'Cooling shelters'}</dt>
        <dd>
          {ja ? '東京都 熱中症対策ポータル「クーリングシェルター・TOKYOクールシェアスポット」' : 'Tokyo Metropolitan Government cooling shelter list'}: {n(a?.pois.cooling, lang)}{ja ? 'か所（住所は国土地理院のジオコーダで位置に変換）' : ' places (geocoded with GSI)'}
        </dd>
        <dt>{ja ? '地図' : 'Map'}</dt>
        <dd>OpenFreeMap / © OpenMapTiles / © OpenStreetMap contributors</dd>
      </dl>

      <h3>{ja ? '正確さと限界' : 'Accuracy and limits'}</h3>
      <ul>
        <li>{ja ? '影は建物と樹木のデータから計算した推定です。看板・ひさし・日傘・雲は含みません。曇りの日は実際の日差しはもっと弱くなります。' : 'Shade is estimated from building and tree data; awnings, signs, parasols and clouds are not included. On cloudy days the sun is weaker than shown.'}</li>
        <li>{ja ? '樹木のデータは一部の地域に限られます。並木道は実際より日なたに見えることがあります。' : 'Tree data covers only some areas, so tree-lined streets can look sunnier than they are.'}</li>
        <li>{ja ? '影を計算するのは東京23区内だけです。区外の部分は「日陰不明」と表示します。' : 'Shade is worked out inside the 23 wards only; walking outside them is shown as “shade unknown”.'}</li>
        <li>{ja ? '駅の構内（改札からホームまで）の時間は目安です。エレベーターの位置は駅によって異なります。' : 'Time inside stations (entrance to platform) is an estimate, and lifts are in different places at each station.'}</li>
        <li>{ja ? '運行情報・遅れは各社の発表時刻とともに表示します。最新の情報は各事業者の発表をご確認ください。' : 'Live status and delays are shown with each operator’s own timestamp; check the operator for the latest.'}</li>
        <li>
          {ja
            ? '本アプリは公共交通オープンデータセンターのデータを利用していますが、内容の正確性・完全性・最新性は保証されません。本アプリについて、各事業者・公共交通オープンデータセンターへのお問い合わせはご遠慮ください。体調がすぐれないときは無理に外出せず、熱中症が疑われるときはすぐに涼しい場所で休み、必要なら救急車（119）を呼んでください。'
            : 'This app uses data from the Public Transportation Open Data Center. Its accuracy, completeness and timeliness are not guaranteed. Please do not contact the operators or ODPT about this app. If you feel unwell, don’t go out; if you suspect heatstroke, rest somewhere cool at once and call 119 if needed.'}
        </li>
      </ul>

      <h3>{ja ? '個人情報' : 'Privacy'}</h3>
      <p>{ja ? '設定とよく行く場所はこの端末にだけ保存されます。現在地は道順を調べるときだけ使い、保存しません。' : 'Settings and saved places stay on this device. Your location is used only to plan and is not stored.'}</p>

      <h3>{ja ? 'お問い合わせ' : 'Contact'}</h3>
      <p>{a?.contact ? <a href={`mailto:${a.contact}`}>{a.contact}</a> : ja ? '（公開時に設定）' : '(set on deployment)'}</p>
      <p className="small muted">NatsuRoute · {ja ? '公共交通オープンデータチャレンジ2026 応募作品' : 'An entry to the Public Transportation Open Data Challenge 2026'}</p>
    </article>
  );
}
