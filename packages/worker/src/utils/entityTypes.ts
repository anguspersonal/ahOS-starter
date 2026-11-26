export function mapEntityType(aiEntityType: string): string {
	if (aiEntityType === 'person' || aiEntityType === 'people') return 'people';
	if (aiEntityType === 'area') return 'area';
	if (aiEntityType === 'project') return 'project';
	if (aiEntityType === 'resource') return 'resource';
	return aiEntityType;
}
