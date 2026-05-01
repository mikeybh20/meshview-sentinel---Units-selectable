
export function convertToCSV(data: any[]): string {
  if (data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const rows = data.map(obj => 
    headers.map(header => {
      let val = obj[header];
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') return JSON.stringify(val).replace(/"/g, '""');
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(',')
  );
  
  return [headers.join(','), ...rows].join('\n');
}

export function parseCSV(csv: string): any[] {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).filter(line => line.trim()).map(line => {
    const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
    const obj: any = {};
    headers.forEach((header, i) => {
      let val: any = values[i];
      // Try to parse JSON and numbers
      try {
        if (val.startsWith('{') || val.startsWith('[')) {
          val = JSON.parse(val);
        } else if (!isNaN(Number(val)) && val !== '') {
          val = Number(val);
        } else if (val === 'true') {
          val = true;
        } else if (val === 'false') {
          val = false;
        }
      } catch (e) {
        // keep as string
      }
      obj[header] = val;
    });
    return obj;
  });
}

export function downloadFile(content: string, fileName: string, mimeType: string = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
