/**
 * 毎日21時に main() を実行するトリガーを作成する
 */
function createDailyTrigger() {
  const allTriggers = ScriptApp.getProjectTriggers();
  for (const trig of allTriggers) {
    if (trig.getHandlerFunction() === 'main') {
      ScriptApp.deleteTrigger(trig);
    }
  }

  // 新たにトリガーを作成
  ScriptApp.newTrigger('main')         // 実行したい関数名
    .timeBased()
    .everyDays(1)                      // 毎日
    .atHour(21)                        // 21時
    .create();
}

/**
 * スクリプトプロパティからNotion APIトークンとデータベースIDを取得
 */
function getNotionCredentials() {
  const scriptProperties = PropertiesService.getScriptProperties();
  return {
    notionApiToken: scriptProperties.getProperty('NOTION_API_TOKEN'),
    notionDatabaseId: scriptProperties.getProperty('NOTION_DATABASE_ID')
  };
}

/**
 * メイン関数: YouTube の新着動画を取得し、その日付ページの子ブロックとして追加
 *              + 除外された動画のリストも同ページに追記。
 */
function main() {
  const { notionApiToken, notionDatabaseId } = getNotionCredentials();

  // 1. 取得対象チャンネルのリスト (必要に応じて増やす)
  const channels = ["UCXXXXXXX", "UCYYYYYY"];

  // 2. 直近24時間の新着動画を全部まとめる
  //    今回は「includedVideos」「excludedVideos」の2つを返す構造にした
  let allIncluded = [];
  let allExcluded = [];
  channels.forEach(channelId => {
    const { included, excluded } = getNewVideos(channelId);
    allIncluded = allIncluded.concat(included);
    allExcluded = allExcluded.concat(excluded);
  });

  if (allIncluded.length === 0 && allExcluded.length === 0) {
    Logger.log("本日は新着動画がありませんでした。");
    return;
  }

  // 3. 日付（例: "2025-01-31"）を取得し、その名前のページを Notion DB で探す or 作成
  const todayStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const dayPageId = findOrCreateDayPage(todayStr, notionApiToken, notionDatabaseId);
  if (!dayPageId) {
    Logger.log("日付ページの取得/作成に失敗したため、終了します。");
    return;
  }

  // 4. 含まれる動画(通常＆プレミア)を埋め込みブロックとして追加
  if (allIncluded.length > 0) {
    const blocks = allIncluded.map(video => {
      const embedUrl = `https://www.youtube.com/embed/${video.videoId}?rel=0&modestbranding=1`;
      return {
        "object": "block",
        "type": "embed",
        "embed": {
          "url": embedUrl
        }
      };
    });
    appendBlocksToPage(dayPageId, blocks, notionApiToken);
  }

  // 5. 除外動画を「除外リスト」としてまとめて追加 (タイトルのみ)
  if (allExcluded.length > 0) {
    // まず「除外リスト」という見出しブロックを1つ入れる
    const headingBlock = {
      "object": "block",
      "type": "heading_2",
      "heading_2": {
        "rich_text": [
          { "text": { "content": "除外リスト" } }
        ]
      }
    };
    // 除外されたタイトルを箇条書きブロックにする例
    const excludedBlocks = allExcluded.map(video => {
      return {
        "object": "block",
        "type": "bulleted_list_item",
        "bulleted_list_item": {
          "rich_text": [
            { "text": { "content": video.title } }
          ]
        }
      };
    });

    // heading + 箇条書きブロック を一括追加
    appendBlocksToPage(dayPageId, [headingBlock, ...excludedBlocks], notionApiToken);
  }

    // 処理が完了したタイミングでメール通知
  MailApp.sendEmail({
    to: "メアド@gmail.com",
    subject: "スクリプト実行通知",
    body: "本日のスクリプトが無事に実行されました。\n" + 
          "実行日時: " + new Date().toLocaleString("ja-JP")
  });
}

/**
 * YouTube チャンネルから新着動画を取得
 * @param {string} channelId
 * @returns {Object} - { included: [{videoId, title}], excluded: [{videoId, title}] }
 */
function getNewVideos(channelId) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  Logger.log(`24時間前(UTC): ${oneDayAgo}`);

  const included = [];
  const excluded = [];

  try {
    // Search.list で24時間以内の動画を取得
    const searchResponse = YouTube.Search.list('snippet', {
      channelId: channelId,
      maxResults: 50,
      order: 'date',
      publishedAfter: oneDayAgo,
      type: 'video'
    });

    const items = searchResponse.items || [];
    if (!items.length) {
      Logger.log(`チャンネルID: ${channelId} に新着動画はありません。`);
      return { included, excluded };
    }

    // 動画IDリスト
    const videoIds = items.map(item => item.id.videoId);

    // 詳細情報 (snippet, contentDetails, liveStreamingDetails)
    const videosResponse = YouTube.Videos.list('snippet,contentDetails,liveStreamingDetails', {
      id: videoIds.join(',')
    });

    const videosItems = videosResponse.items || [];
    if (!videosItems.length) {
      Logger.log('動画の詳細情報が取得できませんでした。');
      return { included, excluded };
    }

    // 「プレミア or ライブで終了後 (actualEndTimeあり)」の場合は、description に "vocal" "ボーカル" が含まれているかチェック
    // 通常アップロード (liveStreamingDetails が無い) は無条件で included に追加
    for (const videoItem of videosItems) {
      const snippet = videoItem.snippet;
      const description = (snippet.description || "").toLowerCase(); // 小文字化
      const title = snippet.title;
      const isLiveType = !!videoItem.liveStreamingDetails; // true/false

      if (!isLiveType) {
        // 通常アップロード → そのまま included
        Logger.log(`通常アップロード動画 -> videoId: ${videoItem.id}, title: ${title}`);
        included.push({ videoId: videoItem.id, title: title });
      } else {
        // liveStreamingDetails がある → 何らかの配信 or プレミア
        const actualEnd = videoItem.liveStreamingDetails.actualEndTime;
        if (!actualEnd) {
          // 現在配信中 or 予約中 → 除外
          Logger.log(`配信中or予約中 -> 除外: ${videoItem.id}, title: ${title}`);
          excluded.push({ videoId: videoItem.id, title: title });
        } else {
          // 配信終了（アーカイブ状態）
          // 概要欄にキーワードの文字が含まれているか
          const keywords = ["vocal", "ボーカル"]
          if (keywords.some(word => description.includes(word))) {
            Logger.log(`ライブ/プレミア終了 + キーワードあり -> included: ${videoItem.id}, title: ${title}`);
            included.push({ videoId: videoItem.id, title: title });
          } else {
            Logger.log(`ライブ/プレミア終了 + キーワードなし -> 除外: ${videoItem.id}, title: ${title}`);
            excluded.push({ videoId: videoItem.id, title: title });
          }
        }
      }
    }

    return { included, excluded };
  } catch (e) {
    Logger.log(`YouTube API呼び出し中にエラーが発生しました（チャンネルID: ${channelId}）: ${e}`);
    return { included, excluded };
  }
}

/**
 * 指定した "Name" プロパティを持つページを Notion DB で探し、存在しなければ作成
 * この際、「日付」プロパティにも dayTitle をセットする例
 * @param {string} dayTitle - 例 "2025-01-31"
 * @param {string} notionApiToken
 * @param {string} databaseId
 * @return {string|null} pageId
 */
function findOrCreateDayPage(dayTitle, notionApiToken, databaseId) {
  // 1. DB内検索
  const queryUrl = `https://api.notion.com/v1/databases/${databaseId}/query`;
  const queryPayload = {
    "filter": {
      "property": "Name",
      "title": {
        "equals": dayTitle
      }
    }
  };
  const queryOptions = {
    "method": "post",
    "headers": {
      "Authorization": "Bearer " + notionApiToken,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28"
    },
    "payload": JSON.stringify(queryPayload)
  };

  try {
    const queryResponse = UrlFetchApp.fetch(queryUrl, queryOptions);
    if (queryResponse.getResponseCode() === 200) {
      const data = JSON.parse(queryResponse.getContentText());
      if (data.results && data.results.length > 0) {
        const pageId = data.results[0].id;
        Logger.log(`既存の日付ページが見つかりました: ${dayTitle}, pageId = ${pageId}`);
        return pageId;
      }
    } else {
      Logger.log("Notion DB クエリに失敗: " + queryResponse.getContentText());
    }
  } catch (err) {
    Logger.log("Notion DB クエリ中にエラー: " + err);
  }

  // 2. 見つからなかった場合 → 新規作成
  Logger.log(`日付ページが見つからないため、新規作成します: ${dayTitle}`);
  const createUrl = "https://api.notion.com/v1/pages";

  // 「日付」プロパティを追加したい場合の例
  // Notion データベースで "日付" というDate型プロパティが存在する前提
  // dayTitle が "2025-01-31" などの日付文字列であれば、そのまま start に入れられる
  const createPayload = {
    "parent": { "database_id": databaseId },
    "properties": {
      "Name": {
        "title": [
          { "text": { "content": dayTitle } }
        ]
      },
      "日付": {
        "date": {
          "start": dayTitle
        }
      }
    }
  };

  const createOptions = {
    "method": "post",
    "headers": {
      "Authorization": "Bearer " + notionApiToken,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28"
    },
    "payload": JSON.stringify(createPayload)
  };

  try {
    const createResponse = UrlFetchApp.fetch(createUrl, createOptions);
    if (createResponse.getResponseCode() === 200 || createResponse.getResponseCode() === 201) {
      const createdData = JSON.parse(createResponse.getContentText());
      const newPageId = createdData.id;
      Logger.log(`日付ページを作成しました: ${dayTitle}, pageId = ${newPageId}`);
      return newPageId;
    } else {
      Logger.log(`日付ページ作成に失敗: ${createResponse.getContentText()}`);
      return null;
    }
  } catch (error) {
    Logger.log(`日付ページ作成中にエラー: ${error}`);
    return null;
  }
}

/**
 * 指定した pageId の末尾に、子ブロックをまとめて追加
 * @param {string} pageId
 * @param {Array} blocks - Notion API 形式のブロック配列
 * @param {string} notionApiToken
 */
function appendBlocksToPage(pageId, blocks, notionApiToken) {
  const url = `https://api.notion.com/v1/blocks/${pageId}/children`;
  const payload = { "children": blocks };
  const options = {
    "method": "patch",  // blocks/{block_id}/children への追加は PATCH
    "headers": {
      "Authorization": "Bearer " + notionApiToken,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28"
    },
    "payload": JSON.stringify(payload)
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    if (res.getResponseCode() === 200) {
      Logger.log(`子ブロックの追加に成功しました。pageId: ${pageId}`);
    } else {
      Logger.log(`子ブロックの追加に失敗: ${res.getContentText()}`);
    }
  } catch (err) {
    Logger.log(`子ブロックの追加中にエラー: ${err}`);
  }
}

