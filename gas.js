// https://script.google.com/home/starred  
function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var texts = params.texts || [];
    var targetLangParam = params.targetLang || 'zh-CN'; 
    var sourceLang = params.sourceLang || '';

    if (texts.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ translations: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var targetLangs = targetLangParam.split(',').map(function(l) { return l.trim(); });

    // --- 每日底层 API 计数器模块 ---
    var props = PropertiesService.getScriptProperties();
    var today = Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd"); 
    var countKey = 'COUNT_' + today;
    var currentCount = parseInt(props.getProperty(countKey) || '0', 10);
    
    var expectedApiCalls = targetLangs.length;
    var newCount = currentCount + expectedApiCalls; 
    props.setProperty(countKey, newCount.toString());
    // ---------------------------------

    for (var i = 0; i < texts.length; i++) {
      if (!texts[i] || texts[i].trim() === "") texts[i] = " ";
    }

    var htmlParts = [];
    for (var i = 0; i < texts.length; i++) {
      htmlParts.push("<div>" + texts[i] + "</div>");
    }
    var combinedHtml = htmlParts.join("");
    
    var multiLangResults = []; 

    for (var langIdx = 0; langIdx < targetLangs.length; langIdx++) {
      var tLang = targetLangs[langIdx];
      var translatedHtml = "";
      var maxRetries = 3;
      
      for (var r = 0; r < maxRetries; r++) {
        try {
          translatedHtml = LanguageApp.translate(combinedHtml, sourceLang, tLang, {contentType: 'html'});
          break;
        } catch (apiErr) {
          if (r === maxRetries - 1) throw apiErr;
          Utilities.sleep(1500);
        }
      }

      var regex = /<div[^>]*>([\s\S]*?)<\/div>/gi;
      var translatedArray = [];
      var match;
      while ((match = regex.exec(translatedHtml)) !== null) {
        translatedArray.push(match[1].trim());
      }

      if (translatedArray.length !== texts.length) {
        translatedArray = [];
        for (var j = 0; j < texts.length; j++) {
          if (texts[j] === " ") {
            translatedArray.push("");
          } else {
            var singleTrans = "";
            for (var sr = 0; sr < 3; sr++) {
              try {
                singleTrans = LanguageApp.translate(texts[j], sourceLang, tLang);
                break;
              } catch (singleErr) {
                if (sr === 2) throw singleErr;
                Utilities.sleep(1000);
              }
            }
            translatedArray.push(singleTrans);
          }
          Utilities.sleep(50); 
        }
      }

      var rtlLangs = ['ar', 'he', 'fa', 'ur'];
      var isRtl = false;
      for (var rl = 0; rl < rtlLangs.length; rl++) {
        if (tLang.indexOf(rtlLangs[rl]) === 0) { isRtl = true; break; }
      }

      for (var k = 0; k < translatedArray.length; k++) {
        var cleanStr = (translatedArray[k] || "").trim();
        if (isRtl && cleanStr !== "") {
          cleanStr = "\u202B" + cleanStr + "\u202C";
        }
        translatedArray[k] = cleanStr;
      }
      
      multiLangResults.push(translatedArray);
    }

    var finalTranslations = [];
    for (var i = 0; i < texts.length; i++) {
      var combinedLine = [];
      for (var l = 0; l < multiLangResults.length; l++) {
        if (multiLangResults[l][i] !== "") {
          combinedLine.push(multiLangResults[l][i]);
        }
      }
      finalTranslations.push(combinedLine.join("\n"));
    }

    // 【新增配额回传】把 newCount 打包返回给 Worker
    return ContentService.createTextOutput(JSON.stringify({ 
      translations: finalTranslations,
      quota: newCount
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
