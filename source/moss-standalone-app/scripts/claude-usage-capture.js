ObjC.import('Foundation');

function run() {
  try {
    const handle = $.NSFileHandle.fileHandleWithStandardInput;
    const data = handle.readDataToEndOfFile;
    const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    const input = JSON.parse(text);
    const home = ObjC.unwrap($.NSHomeDirectory());
    const directory = `${home}/.claude`;
    const output = `${directory}/moss-usage.json`;
    $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
      directory, true, $(), null
    );
    const safe = JSON.stringify({ rate_limits: input.rate_limits || null, captured_at: new Date().toISOString() });
    $(safe).writeToFileAtomicallyEncodingError(output, true, $.NSUTF8StringEncoding, null);
    const five = input.rate_limits?.five_hour?.used_percentage;
    const week = input.rate_limits?.seven_day?.used_percentage;
    return [input.model?.display_name || 'Claude', Number.isFinite(five) ? `5h ${Math.round(five)}%` : null, Number.isFinite(week) ? `7d ${Math.round(week)}%` : null].filter(Boolean).join(' · ');
  } catch (_) {
    return 'Claude';
  }
}
