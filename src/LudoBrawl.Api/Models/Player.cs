namespace LudoBrawl.Api.Models;

public class Player
{
    public int Id { get; init; }
    public required string Token { get; init; }
    public required string Name { get; set; }
    public Color Color { get; set; }

}
